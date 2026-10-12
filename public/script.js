document.addEventListener('DOMContentLoaded', () => {
    const chatMessages = document.getElementById('chat-messages');
    const conversation = document.getElementById('conversation');
    const welcome = document.getElementById('welcome');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const providerSelect = document.getElementById('provider-select');
    const modelSelect = document.getElementById('model-select');
    const scanModelsBtn = document.getElementById('scan-models-btn');
    const modelStatus = document.getElementById('model-status');
    const attachmentInput = document.getElementById('attachment-input');
    const attachmentPreview = document.getElementById('attachment-preview');
    const attachBtn = document.getElementById('attach-btn');
    const apiKeyDialog = document.getElementById('api-key-dialog');
    const apiKeyForm = document.getElementById('api-key-form');
    const apiKeyStatus = document.getElementById('api-key-status');
    const apiKeyTitle = document.getElementById('api-key-title');
    const apiKeyButton = document.getElementById('api-key-btn');
    const logoutButton = document.getElementById('logout-btn');

    const providerDetails = {
        'nvidia-nim': { name: 'NVIDIA NIM', keyName: 'nvidia-api-key' },
        'google-ai-studio': { name: 'Google AI Studio', keyName: 'google-ai-studio-api-key' },
        openrouter: { name: 'OpenRouter', keyName: 'openrouter-api-key' }
    };
    let conversationHistory = [];
    let attachments = [];
    let displayedMediaUrls = [];
    let availableModels = [];
    let conversationAttachmentBytes = 0;
    let isSending = false;

    function getProviderDetails() {
        return providerDetails[providerSelect.value];
    }

    function getApiKey() {
        return sessionStorage.getItem(`grok-chat:${getProviderDetails().keyName}`) || '';
    }

    function updateApiKeyStatus() {
        const provider = getProviderDetails();
        const configured = Boolean(getApiKey());
        apiKeyButton.textContent = configured ? `${provider.name} key added` : `Add ${provider.name} key`;
        apiKeyButton.classList.toggle('key-configured', configured);
    }

    function openApiKeyDialog() {
        apiKeyTitle.textContent = 'Provider API keys';
        apiKeyForm.querySelectorAll('[data-api-provider]').forEach((input) => {
            const provider = providerDetails[input.dataset.apiProvider];
            const configured = Boolean(sessionStorage.getItem(`grok-chat:${provider.keyName}`));
            input.value = '';
            input.placeholder = configured ? 'Saved for this tab; enter to replace' : `Paste your ${provider.name} key`;
            apiKeyForm.querySelector(`[data-remove-provider="${input.dataset.apiProvider}"]`).disabled = !configured;
        });
        apiKeyStatus.textContent = 'Enter one or more keys to save or replace them. Leave other fields blank to keep their saved keys.';
        apiKeyDialog.showModal();
        apiKeyForm.querySelector(`[data-api-provider="${providerSelect.value}"]`).focus();
    }

    function scrollToBottom() {
        conversation.scrollTop = conversation.scrollHeight;
    }

    function getTextContent(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n');
    }

    function addMessage(content, role) {
        const message = document.createElement('article');
        message.className = `message ${role}`;
        if (role === 'assistant') message.classList.add('response-entering');
        const messageText = getTextContent(content);
        if (messageText) {
            const text = document.createElement('p');
            text.className = 'message-text';
            text.textContent = messageText;
            message.appendChild(text);
        }

        if (Array.isArray(content)) {
            const media = document.createElement('div');
            media.className = 'message-media';
            content.forEach((part) => {
                const url = part.image_url?.url || part.video_url?.url;
                if (!url) return;
                const element = part.type === 'video_url'
                    ? document.createElement('video')
                    : document.createElement('img');
                element.src = url;
                if (element instanceof HTMLVideoElement) {
                    element.controls = true;
                    element.preload = 'metadata';
                } else {
                    element.alt = 'Attached image';
                }
                media.appendChild(element);
            });
            if (media.childElementCount) message.appendChild(media);
        }

        chatMessages.appendChild(message);
        welcome.hidden = true;
        scrollToBottom();
        return message;
    }

    async function readJsonResponse(response) {
        const body = await response.text();
        let data;
        try {
            data = body ? JSON.parse(body) : {};
        } catch {
            const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240);
            throw new Error(
                `Server returned a non-JSON response (${response.status})${detail ? `: ${detail}` : '.'}`
            );
        }

        if (!response.ok) {
            const error = new Error(data.error || `Request failed (${response.status}).`);
            error.unavailableModel = data.unavailableModel;
            error.unsupportedMediaModel = data.unsupportedMediaModel === true;
            error.providerAuthenticationError = data.providerAuthenticationError === true;
            throw error;
        }
        return data;
    }

    async function readEventStream(response, onText) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let message = '';

        function processEvent(event) {
            const payload = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
            if (!payload || payload === '[DONE]') return;

            let data;
            try {
                data = JSON.parse(payload);
            } catch {
                throw new Error('The model returned an invalid streaming response.');
            }
            if (data.error) {
                throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
            }

            const content = data.choices?.[0]?.delta?.content;
            const text = typeof content === 'string'
                ? content
                : Array.isArray(content)
                    ? content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('')
                    : '';
            if (text) {
                message += text;
                onText(message);
            }
        }

        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop();
            events.forEach(processEvent);
            if (done) break;
        }
        if (buffer.trim()) processEvent(buffer);
        if (!message) throw new Error('The model stream did not include a response.');
        return message;
    }

    async function scanModels() {
        const apiKey = getApiKey();
        if (!apiKey) {
            modelSelect.disabled = true;
            modelSelect.replaceChildren(new Option('Add your API key first', ''));
            modelStatus.textContent = `Add your ${getProviderDetails().name} API key to scan models.`;
            openApiKeyDialog();
            return;
        }

        const provider = providerSelect.value;
        const selectedModel = modelSelect.value;
        scanModelsBtn.disabled = true;
        scanModelsBtn.classList.add('spinning');
        modelStatus.textContent = 'Scanning available models...';
        modelSelect.disabled = true;
        modelSelect.replaceChildren(new Option('Loading models...', ''));

        try {
            const response = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, {
                headers: { 'X-Provider-API-Key': apiKey }
            });
            const data = await readJsonResponse(response);
            if (!Array.isArray(data.models)) {
                throw new Error('The model list response was invalid. Please scan again.');
            }
            modelSelect.replaceChildren();
            availableModels = data.models.map((model) => ({
                ...model,
                capabilities: Array.isArray(model.capabilities) ? model.capabilities : []
            }));
            addModelGroup('Chat & text', availableModels.filter((model) => model.capabilities.length === 0));
            addModelGroup('Image & video understanding (sampled frames)', availableModels.filter((model) =>
                model.capabilities.includes('image')
            ));
            if (availableModels.length) {
                const availableModelIds = new Set(availableModels.map((model) => model.id));
                const preferredModel = availableModelIds.has(selectedModel)
                    ? selectedModel
                    : availableModels[0].id;
                modelSelect.value = preferredModel;
                modelSelect.disabled = false;
                const imageCount = availableModels.filter((model) => model.capabilities.includes('image')).length;
                const videoCount = availableModels.filter((model) => model.capabilities.includes('video')).length;
                modelStatus.textContent = `${availableModels.length} models · ${imageCount} image · ${videoCount} video`;
                ensureModelSupportsAttachments();
            } else {
                availableModels = [];
                modelSelect.add(new Option('No models available', ''));
                modelStatus.textContent = 'No models were returned by this provider. Try scanning again.';
            }
        } catch (error) {
            availableModels = [];
            modelSelect.replaceChildren(new Option('Could not load models', ''));
            modelStatus.textContent = error.message;
        } finally {
            scanModelsBtn.disabled = false;
            scanModelsBtn.classList.remove('spinning');
        }
    }

    function addModelGroup(label, models) {
        if (!models.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        models.forEach((model) => group.appendChild(new Option(model.name, model.id)));
        modelSelect.appendChild(group);
    }

    function getConversationMediaTypes() {
        const types = new Set();
        conversationHistory.forEach((message) => {
            (message.mediaTypes || []).forEach((type) => types.add(type));
        });
        attachments.forEach((file) => {
            types.add(file.type.startsWith('video/') ? 'video' : 'image');
        });
        return [...types];
    }

    function ensureModelSupportsAttachments() {
        const mediaTypes = getConversationMediaTypes();
        if (!mediaTypes.length) return true;

        const selectedModel = availableModels.find((model) => model.id === modelSelect.value);
        if (selectedModel && mediaTypes.every((type) => selectedModel.capabilities.includes(type))) {
            return true;
        }

        const compatibleModel = availableModels.find((model) =>
            mediaTypes.every((type) => model.capabilities.includes(type))
        );
        if (compatibleModel) {
            modelSelect.value = compatibleModel.id;
            modelStatus.textContent = `Switched to ${compatibleModel.name} for ${mediaTypes.join(' and ')} input`;
            return true;
        }

        modelStatus.textContent = `No available model supports ${mediaTypes.join(' and ')} input.`;
        return false;
    }

    function updateAttachmentPreview() {
        attachmentPreview.replaceChildren();
        attachments.forEach((file, index) => {
            const item = document.createElement('div');
            item.className = 'attachment-item';
            const preview = file.type.startsWith('video/')
                ? document.createElement('video')
                : document.createElement('img');
            preview.src = file.previewUrl;
            preview.alt = file.name;
            if (preview instanceof HTMLVideoElement) preview.muted = true;
            item.appendChild(preview);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remove-attachment';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `Remove ${file.name}`);
            remove.addEventListener('click', () => {
                URL.revokeObjectURL(file.previewUrl);
                attachments.splice(index, 1);
                updateAttachmentPreview();
            });
            item.appendChild(remove);
            attachmentPreview.appendChild(item);
        });
        attachmentPreview.hidden = attachments.length === 0;
    }

    async function imageToDataUrl(file) {
        let image;
        try {
            image = await createImageBitmap(file);
        } catch {
            throw new Error(`Could not read ${file.name} as an image.`);
        }

        try {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Your browser could not prepare this image.');

            let scale = Math.min(1, 1600 / image.width, 1600 / image.height);
            const maxBytes = 700 * 1024;
            while (scale >= 0.25) {
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                context.drawImage(image, 0, 0, canvas.width, canvas.height);

                for (const quality of [0.82, 0.68, 0.54, 0.4]) {
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    if ((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75 <= maxBytes) {
                        return dataUrl;
                    }
                }
                scale *= 0.75;
            }
            throw new Error(`Could not compress ${file.name} enough to send it.`);
        } finally {
            image.close();
        }
    }

    function prepareRequestMessages(history) {
        const latestUserMessage = history.findLastIndex((message) => message.role === 'user');
        return history.map((message, index) => {
            let content = message.content;
            if (message.mediaTypes?.length && index !== latestUserMessage && Array.isArray(content)) {
                content = content.filter((part) =>
                    part.type !== 'image_url' &&
                    !(part.type === 'text' && /^Video frame at [\d.]+ seconds:$/.test(part.text))
                );
                content.push({
                    type: 'text',
                    text: 'Media attached in this earlier message was omitted from follow-up context.'
                });
            }
            return {
                role: message.role,
                content,
                ...(message.mediaTypes?.length ? { mediaTypes: message.mediaTypes } : {})
            };
        });
    }

    function waitForMediaEvent(element, eventName) {
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                cleanup();
                reject(new Error('Timed out while processing the video.'));
            }, 15000);
            const cleanup = () => {
                window.clearTimeout(timeout);
                element.removeEventListener(eventName, onSuccess);
                element.removeEventListener('error', onError);
            };
            const onSuccess = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('This video could not be decoded by your browser.'));
            };
            element.addEventListener(eventName, onSuccess, { once: true });
            element.addEventListener('error', onError, { once: true });
        });
    }

    async function extractVideoFrames(file, options = {}) {
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;
        const metadataLoaded = waitForMediaEvent(video, 'loadedmetadata');
        video.src = file.previewUrl;

        await metadataLoaded;
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
            throw new Error(`Could not read the duration of ${file.name}.`);
        }

        const duration = video.duration;
        const frameCount = Math.min(
            options.maxFrames || 8,
            Math.max(2, Math.ceil(duration / 5) + 1)
        );
        const maxDimension = options.maxDimension || 768;
        const maxFrameBytes = options.maxFrameBytes;
        const quality = options.quality || 0.75;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Your browser could not prepare video frames.');

        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForMediaEvent(video, 'loadeddata');
        }
        const frames = [];
        for (let index = 0; index < frameCount; index += 1) {
            const timestamp = frameCount === 1
                ? 0
                : (duration * 0.95 * index) / (frameCount - 1);
            if (index > 0) {
                const seeked = waitForMediaEvent(video, 'seeked');
                video.currentTime = timestamp;
                await seeked;
            }

            let scale = Math.min(1, maxDimension / video.videoWidth, maxDimension / video.videoHeight);
            let dataUrl;
            do {
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (!maxFrameBytes || dataUrl.length * 0.75 <= maxFrameBytes || scale <= 0.25) break;
                scale = Math.max(0.25, scale * 0.75);
            } while (true);
            if (maxFrameBytes && dataUrl.length * 0.75 > maxFrameBytes) {
                throw new Error(`Could not compress a video frame enough for the selected video model.`);
            }
            frames.push({
                timestamp,
                dataUrl
            });
        }

        video.removeAttribute('src');
        video.load();
        return { duration, frames };
    }

    async function sendMessage() {
        if (isSending) return;
        const userText = userInput.value.trim();
        if (!userText && attachments.length === 0) return;

        const model = modelSelect.value;
        if (!model) {
            modelStatus.textContent = 'Choose a model from the list before sending.';
            modelSelect.focus();
            return;
        }
        if (!ensureModelSupportsAttachments()) {
            modelSelect.focus();
            return;
        }
        const apiKey = getApiKey();
        if (!apiKey) {
            openApiKeyDialog();
            return;
        }

        isSending = true;
        sendBtn.disabled = true;
        attachBtn.disabled = true;
        providerSelect.disabled = true;
        userInput.disabled = true;
        const selectedAttachments = attachments.slice();
        const displayContent = [];
        const requestContent = [];
        if (userText) {
            displayContent.push({ type: 'text', text: userText });
            requestContent.push({ type: 'text', text: userText });
        }

        try {
            for (const file of selectedAttachments) {
                if (file.type.startsWith('video/')) {
                    const frameOptions = providerSelect.value === 'openrouter'
                        ? { maxFrameBytes: 80 * 1024, maxFrames: 4, maxDimension: 512, quality: 0.5 }
                        : { maxFrameBytes: 160 * 1024, maxFrames: 8, maxDimension: 768, quality: 0.55 };
                    const { duration, frames } = await extractVideoFrames(
                        file,
                        frameOptions
                    );
                    displayContent.push({ type: 'video_url', video_url: { url: file.previewUrl } });
                    displayedMediaUrls.push(file.previewUrl);
                    requestContent.push({
                        type: 'text',
                        text: `Video "${file.name}" (${durationLabel(duration)}). The following images are sampled frames in chronological order; use them to describe the visual events and changes. The video audio is not available.`
                    });
                    frames.forEach((frame) => {
                        requestContent.push({
                            type: 'text',
                            text: `Video frame at ${frame.timestamp.toFixed(1)} seconds:`
                        });
                        requestContent.push({
                            type: 'image_url',
                            image_url: { url: frame.dataUrl }
                        });
                    });
                } else {
                    const dataUrl = await imageToDataUrl(file.file);
                    const imagePart = { type: 'image_url', image_url: { url: dataUrl } };
                    displayContent.push(imagePart);
                    requestContent.push(imagePart);
                }
            }

            if (!userText && requestContent.length) {
                const prompt = { type: 'text', text: 'Please describe or analyze the attached image or video frames.' };
                displayContent.unshift(prompt);
                requestContent.unshift(prompt);
            }

            const requestMessageContent = requestContent.length === 1 && requestContent[0].type === 'text'
                ? requestContent[0].text
                : requestContent;
            addMessage(displayContent, 'user');
            const mediaTypes = [...new Set(selectedAttachments.map((file) =>
                file.type.startsWith('video/') ? 'video' : 'image'
            ))];
            conversationHistory.push({ role: 'user', content: requestMessageContent, mediaTypes });
            conversationAttachmentBytes += selectedAttachments.reduce((sum, file) => sum + file.size, 0);

            const title = userText || selectedAttachments[0]?.name || 'Media conversation';
            document.getElementById('chat-title').textContent =
                title.length > 48 ? `${title.slice(0, 45)}...` : title;
            document.getElementById('sidebar-chat-title').textContent =
                title.length > 30 ? `${title.slice(0, 27)}...` : title;
            userInput.value = '';
            userInput.style.height = 'auto';
            attachments = [];
            updateAttachmentPreview();

            const typingIndicator = document.createElement('div');
            typingIndicator.className = 'typing-indicator';
            typingIndicator.textContent = 'Thinking';
            chatMessages.appendChild(typingIndicator);
            scrollToBottom();

            const requestBody = JSON.stringify({
                messages: prepareRequestMessages(conversationHistory),
                provider: providerSelect.value,
                model
            });
            const requestSize = new TextEncoder().encode(requestBody).byteLength;
            const maxRequestBytes = 3.5 * 1024 * 1024;
            if (requestSize > maxRequestBytes) {
                throw new Error('This chat request is still too large to send. Attach fewer images or videos, or start a new chat.');
            }

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Provider-API-Key': apiKey
                },
                body: requestBody
            });
            typingIndicator.remove();
            let aiMessage;
            if (response.headers.get('content-type')?.includes('text/event-stream')) {
                const streamingMessage = document.createElement('article');
                streamingMessage.className = 'message assistant response-entering';
                const text = document.createElement('p');
                text.className = 'message-text streaming-text';
                streamingMessage.appendChild(text);
                chatMessages.appendChild(streamingMessage);
                welcome.hidden = true;
                try {
                    aiMessage = await readEventStream(response, (content) => {
                        text.textContent = content;
                        scrollToBottom();
                    });
                } finally {
                    streamingMessage.classList.remove('response-entering');
                    text.classList.remove('streaming-text');
                }
            } else {
                const data = await readJsonResponse(response);
                aiMessage = data.message;
                addMessage(aiMessage, 'assistant');
            }
            conversationHistory.push({ role: 'assistant', content: aiMessage });
        } catch (error) {
            console.error('Error:', error);
            const typingIndicator = chatMessages.querySelector('.typing-indicator');
            typingIndicator?.remove();
            if (error.providerAuthenticationError && providerSelect.value === 'openrouter') {
                availableModels = [];
                modelSelect.replaceChildren(new Option('OpenRouter key rejected', ''));
                modelSelect.disabled = true;
                modelStatus.textContent = 'OpenRouter rejected this key. Re-enter your OpenRouter API key, then scan models again.';
                addMessage('OpenRouter rejected the API key or did not receive it. Open API key settings, re-enter your OpenRouter key, and scan the free models again.', 'error');
            } else if (error.unavailableModel) {
                availableModels = availableModels.filter((model) => model.id !== error.unavailableModel);
                modelSelect.replaceChildren();
                addModelGroup('Chat & text', availableModels.filter((model) => model.capabilities.length === 0));
                addModelGroup('Image & video understanding (sampled frames)', availableModels.filter((model) =>
                    model.capabilities.includes('image')
                ));
                const mediaTypes = getConversationMediaTypes();
                const supportsConversation = (candidate) =>
                    mediaTypes.every((type) => candidate.capabilities.includes(type));
                const fallbackModel = availableModels.find((candidate) =>
                    candidate.capabilities.length === 0 && supportsConversation(candidate)
                ) || availableModels.find(supportsConversation);
                modelSelect.disabled = !fallbackModel;
                if (fallbackModel) {
                    modelSelect.value = fallbackModel.id;
                    modelStatus.textContent = error.unsupportedMediaModel
                        ? `${error.unavailableModel} rejected these video frames. Switched to ${fallbackModel.name}.`
                        : `${error.unavailableModel} is unavailable. Switched to ${fallbackModel.name}.`;
                } else {
                    modelStatus.textContent = error.unsupportedMediaModel
                        ? `${error.unavailableModel} rejected these video frames. Choose another image-capable model.`
                        : `${error.unavailableModel} is unavailable. Scan again or choose a model that supports this conversation's attachments.`;
                }
            }
            addMessage(`Error: ${error.message}`, 'error');
        } finally {
            isSending = false;
            sendBtn.disabled = false;
            attachBtn.disabled = false;
            providerSelect.disabled = false;
            userInput.disabled = false;
            userInput.focus();
        }
    }

    function durationLabel(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.round(seconds % 60);
        return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
    }

    function addFiles(fileList) {
        const files = Array.from(fileList);
        if (!files.length) return;
        if (isSending) {
            modelStatus.textContent = 'Wait for the current response to finish before adding attachments.';
            return;
        }
        const currentSize = attachments.reduce((sum, file) => sum + file.size, 0);
        const addedSize = files.reduce((sum, file) => sum + file.size, 0);
        if (conversationAttachmentBytes + currentSize + addedSize > 20 * 1024 * 1024) {
            modelStatus.textContent = 'Attachments must total 20 MB or less per conversation. Start a new chat to reset the limit.';
            return;
        }

        const unsupported = files.find((file) =>
            !file.type.startsWith('image/') && !file.type.startsWith('video/')
        );
        if (unsupported) {
            modelStatus.textContent = `${unsupported.name} is not an image or video file.`;
            return;
        }

        const mediaTypes = new Set(files.map((file) =>
            file.type.startsWith('video/') ? 'video' : 'image'
        ));
        const requiredMediaTypes = new Set([...getConversationMediaTypes(), ...mediaTypes]);
        const compatibleModel = availableModels.find((model) =>
            [...requiredMediaTypes].every((type) => model.capabilities.includes(type))
        );
        if (!compatibleModel) {
            modelStatus.textContent = `No scanned model supports ${[...requiredMediaTypes].join(' and ')} input.`;
            return;
        }

        files.forEach((file) => attachments.push({
            file,
            name: file.name,
            type: file.type,
            size: file.size,
            previewUrl: URL.createObjectURL(file)
        }));
        if (modelSelect.value !== compatibleModel.id) {
            modelSelect.value = compatibleModel.id;
            modelStatus.textContent = `Selected ${compatibleModel.name} for ${[...requiredMediaTypes].join(' and ')} input`;
        }
        updateAttachmentPreview();
        attachmentInput.value = '';
        userInput.focus();
    }

    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = `${Math.min(userInput.scrollHeight, 180)}px`;
    });
    providerSelect.addEventListener('change', () => {
        updateApiKeyStatus();
        scanModels();
    });
    scanModelsBtn.addEventListener('click', scanModels);
    modelSelect.addEventListener('change', ensureModelSupportsAttachments);
    attachBtn.addEventListener('click', () => attachmentInput.click());
    attachmentInput.addEventListener('change', () => addFiles(attachmentInput.files));
    let dragDepth = 0;
    function isFileDrag(event) {
        return Array.from(event.dataTransfer?.types || []).includes('Files');
    }

    window.addEventListener('dragenter', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth += 1;
        conversation.classList.add('is-dragging');
    });
    window.addEventListener('dragover', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
        if (!isFileDrag(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) conversation.classList.remove('is-dragging');
    });
    window.addEventListener('drop', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth = 0;
        conversation.classList.remove('is-dragging');
        addFiles(event.dataTransfer.files);
    });
    apiKeyButton.addEventListener('click', openApiKeyDialog);
    logoutButton.addEventListener('click', async () => {
        logoutButton.disabled = true;
        try {
            const response = await fetch('/api/access/logout', { method: 'POST' });
            if (!response.ok) throw new Error(`Could not lock the workspace (${response.status}).`);
            window.location.replace('/login');
        } catch (error) {
            console.error('Could not lock workspace:', error);
            modelStatus.textContent = 'Could not lock the workspace. Check your connection and try again.';
            logoutButton.disabled = false;
        }
    });
    document.getElementById('close-api-key').addEventListener('click', () => apiKeyDialog.close());
    apiKeyForm.addEventListener('submit', (event) => {
        event.preventDefault();
        let savedCount = 0;
        apiKeyForm.querySelectorAll('[data-api-provider]').forEach((input) => {
            const apiKey = input.value.trim();
            if (!apiKey) return;
            const provider = providerDetails[input.dataset.apiProvider];
            sessionStorage.setItem(`grok-chat:${provider.keyName}`, apiKey);
            input.value = '';
            savedCount += 1;
        });
        if (!savedCount) {
            apiKeyStatus.textContent = 'No new keys entered. Any keys already saved for this tab were kept.';
            return;
        }
        apiKeyStatus.textContent = `${savedCount} API key${savedCount === 1 ? '' : 's'} saved for this browser tab.`;
        updateApiKeyStatus();
        apiKeyDialog.close();
        if (getApiKey()) {
            scanModels();
        } else {
            modelStatus.textContent = `Key saved. Select ${getProviderDetails().name} in the provider list to load its models.`;
        }
    });
    apiKeyForm.querySelectorAll('[data-remove-provider]').forEach((button) => {
        button.addEventListener('click', () => {
            const provider = providerDetails[button.dataset.removeProvider];
            sessionStorage.removeItem(`grok-chat:${provider.keyName}`);
            const input = apiKeyForm.querySelector(`[data-api-provider="${button.dataset.removeProvider}"]`);
            input.value = '';
            input.placeholder = `Paste your ${provider.name} key`;
            button.disabled = true;
            apiKeyStatus.textContent = `${provider.name} key removed from this browser tab.`;
            if (button.dataset.removeProvider === providerSelect.value) {
                updateApiKeyStatus();
                availableModels = [];
                modelSelect.disabled = true;
                modelSelect.replaceChildren(new Option('Add your API key first', ''));
                modelStatus.textContent = `${provider.name} API key removed from this browser tab.`;
            }
        });
    });

    function newChat() {
        conversationHistory = [];
        conversationAttachmentBytes = 0;
        chatMessages.replaceChildren();
        welcome.hidden = false;
        document.getElementById('chat-title').textContent = 'New chat';
        document.getElementById('sidebar-chat-title').textContent = 'New conversation';
        attachments.forEach((file) => URL.revokeObjectURL(file.previewUrl));
        displayedMediaUrls.forEach((url) => URL.revokeObjectURL(url));
        displayedMediaUrls = [];
        attachments = [];
        updateAttachmentPreview();
        userInput.value = '';
        userInput.focus();
    }

    document.getElementById('new-chat-btn').addEventListener('click', newChat);
    document.getElementById('mobile-new-chat').addEventListener('click', newChat);
    document.querySelectorAll('.suggestion').forEach((button) => {
        button.addEventListener('click', () => {
            userInput.value = button.dataset.prompt;
            userInput.focus();
            userInput.dispatchEvent(new Event('input'));
        });
    });

    updateApiKeyStatus();
    scanModels();
    userInput.focus();
});
