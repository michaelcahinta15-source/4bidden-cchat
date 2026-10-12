(() => {
    const storageKey = '4bidden-analytics';
    const analyticsLink = document.querySelector('.analytics-link');
    let visitorId;
    let sessionId;

    fetch('/api/access/session', { cache: 'no-store' })
        .then((response) => {
            if (!response.ok) throw new Error(`Could not check analytics access (${response.status}).`);
            return response.json();
        })
        .then(({ canViewAnalytics }) => {
            if (analyticsLink) analyticsLink.hidden = !canViewAnalytics;
        })
        .catch((error) => {
            console.error('Could not check analytics access:', error);
        });

    try {
        visitorId = localStorage.getItem(`${storageKey}:visitor`);
        if (!visitorId) {
            visitorId = crypto.randomUUID();
            localStorage.setItem(`${storageKey}:visitor`, visitorId);
        }

        sessionId = sessionStorage.getItem(`${storageKey}:session`);
        if (!sessionId) {
            sessionId = crypto.randomUUID();
            sessionStorage.setItem(`${storageKey}:session`, sessionId);
        }
    } catch (error) {
        console.error('Could not initialize anonymous usage analytics:', error);
        return;
    }

    const sendHeartbeat = () => {
        if (navigator.sendBeacon) {
            const payload = new Blob(
                [JSON.stringify({ visitorId, sessionId })],
                { type: 'application/json' }
            );
            if (navigator.sendBeacon('/api/analytics/heartbeat', payload)) return;
        }

        fetch('/api/analytics/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId, sessionId }),
            keepalive: true
        }).catch((error) => {
            console.error('Could not update anonymous usage analytics:', error);
        });
    };

    sendHeartbeat();
    window.setInterval(sendHeartbeat, 30_000);
})();
