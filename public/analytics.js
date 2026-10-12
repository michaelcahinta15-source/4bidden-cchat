document.addEventListener('DOMContentLoaded', () => {
    const activeUsers = document.getElementById('active-users');
    const pageViews = document.getElementById('page-views');
    const uniqueVisitors = document.getElementById('unique-visitors');
    const chart = document.getElementById('traffic-chart');
    const liveError = document.getElementById('live-error');
    const logInput = document.getElementById('log-input');
    const logFile = document.getElementById('log-file');
    const parseStatus = document.getElementById('parse-status');
    const results = document.getElementById('log-results');

    function renderChart(dailyViews) {
        chart.replaceChildren();
        const days = [];
        const today = new Date();
        for (let index = 13; index >= 0; index -= 1) {
            const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - index));
            const key = date.toISOString().slice(0, 10);
            days.push({ key, label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`, views: 0 });
        }
        dailyViews.forEach(({ date, views }) => {
            const day = days.find((item) => item.key === date);
            if (day) day.views = views;
        });
        const maxViews = Math.max(1, ...days.map((day) => day.views));
        days.forEach((day) => {
            const column = document.createElement('div');
            column.className = 'chart-column';
            column.title = `${day.key}: ${day.views} page views`;
            const bar = document.createElement('div');
            bar.className = 'chart-bar';
            bar.style.height = `${Math.max(3, (day.views / maxViews) * 100)}%`;
            const date = document.createElement('span');
            date.className = 'chart-date';
            date.textContent = day.label;
            column.append(bar, date);
            chart.appendChild(column);
        });
    }

    async function refreshSummary() {
        try {
            const response = await fetch('/api/analytics/summary', { cache: 'no-store' });
            if (!response.ok) throw new Error(response.status === 401 ? 'Your login session has expired.' : `Analytics request failed (${response.status}).`);
            const summary = await response.json();
            activeUsers.textContent = summary.activeUsers.toLocaleString();
            pageViews.textContent = summary.pageViews.toLocaleString();
            uniqueVisitors.textContent = summary.uniqueVisitors.toLocaleString();
            renderChart(summary.dailyViews);
            liveError.hidden = true;
            document.getElementById('last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } catch (error) {
            liveError.textContent = `Could not load live metrics: ${error.message}`;
            liveError.hidden = false;
        }
    }

    function parseLogLine(line) {
        const match = line.match(/^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(.+?)\s+HTTP\/[^"]+"\s+(\d{3})\s+\S+/);
        if (!match) return null;
        const [, address, timestamp, method, requestTarget, statusText] = match;
        const path = requestTarget.split(/[?#]/, 1)[0] || '/';
        const dateMatch = timestamp.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):/);
        const month = dateMatch && Date.parse(`${dateMatch[2]} 1, 2000`);
        return {
            address,
            path: path.slice(0, 2048),
            method,
            status: Number(statusText),
            date: dateMatch && Number.isFinite(month)
                ? `${dateMatch[3]}-${String(new Date(month).getMonth() + 1).padStart(2, '0')}-${dateMatch[1]}`
                : null
        };
    }

    function analyzeLogs() {
        if (new Blob([logInput.value]).size > 5 * 1024 * 1024) {
            parseStatus.textContent = 'Log data is larger than the 5 MB limit.';
            results.hidden = true;
            return;
        }
        const lines = logInput.value.split(/\r?\n/).filter((line) => line.trim());
        if (!lines.length) {
            parseStatus.textContent = 'Paste or choose a log file first.';
            results.hidden = true;
            return;
        }

        const parsed = lines.map(parseLogLine).filter(Boolean);
        if (!parsed.length) {
            parseStatus.textContent = 'No supported Apache/Nginx access-log lines were found. Use the common or combined log format.';
            results.hidden = true;
            return;
        }

        const addresses = new Set(parsed.map((entry) => entry.address));
        const pathCounts = new Map();
        parsed.forEach(({ path }) => pathCounts.set(path, (pathCounts.get(path) || 0) + 1));
        document.getElementById('log-requests').textContent = parsed.length.toLocaleString();
        document.getElementById('log-addresses').textContent = addresses.size.toLocaleString();
        document.getElementById('log-errors').textContent = parsed.filter(({ status }) => status >= 400).length.toLocaleString();
        document.getElementById('log-skipped').textContent = (lines.length - parsed.length).toLocaleString();

        const topPaths = [...pathCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
        const pathList = document.getElementById('top-path-list');
        pathList.replaceChildren();
        topPaths.forEach(([path, count]) => {
            const item = document.createElement('li');
            const label = document.createElement('strong');
            label.textContent = `${path} `;
            item.append(label, document.createTextNode(`${count} requests`));
            pathList.appendChild(item);
        });
        results.hidden = false;
        parseStatus.textContent = `Analyzed ${parsed.length.toLocaleString()} request${parsed.length === 1 ? '' : 's'}; ${lines.length - parsed.length} line${lines.length - parsed.length === 1 ? '' : 's'} could not be parsed.`;
    }

    document.getElementById('analyze-btn').addEventListener('click', analyzeLogs);
    document.getElementById('clear-btn').addEventListener('click', () => {
        logInput.value = '';
        logFile.value = '';
        results.hidden = true;
        parseStatus.textContent = 'No log data loaded.';
    });
    logFile.addEventListener('change', async () => {
        const [file] = logFile.files;
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            parseStatus.textContent = 'That file is larger than the 5 MB limit.';
            logFile.value = '';
            return;
        }
        try {
            logInput.value = await file.text();
            parseStatus.textContent = `Loaded ${file.name}. Select “Analyze logs” to view the results.`;
            results.hidden = true;
        } catch (error) {
            parseStatus.textContent = `Could not read this file: ${error.message}`;
        }
    });

    refreshSummary();
    window.setInterval(refreshSummary, 15_000);
});
