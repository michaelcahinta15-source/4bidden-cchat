document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('access-form');
    const keyInput = document.getElementById('access-key');
    const status = document.getElementById('access-status');
    const submitButton = document.getElementById('unlock-button');
    const toggleButton = document.getElementById('toggle-key');

    toggleButton.addEventListener('click', () => {
        const reveal = keyInput.type === 'password';
        keyInput.type = reveal ? 'text' : 'password';
        toggleButton.setAttribute('aria-label', reveal ? 'Hide access key' : 'Show access key');
        toggleButton.title = reveal ? 'Hide access key' : 'Show access key';
        keyInput.focus();
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.textContent = '';
        submitButton.disabled = true;
        submitButton.querySelector('span').textContent = 'Checking key...';

        try {
            const response = await fetch('/api/access/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: keyInput.value })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `Could not sign in (${response.status}).`);
            window.location.replace('/');
        } catch (error) {
            status.textContent = error.message;
            keyInput.select();
        } finally {
            submitButton.disabled = false;
            submitButton.querySelector('span').textContent = 'Unlock workspace';
        }
    });
});
