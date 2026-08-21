// XHR/Fetch/Document/WebSocket are what an action button actually triggers.
// Everything else (images, css, fonts, scripts) is page-load noise that would
// otherwise drown out the one API call the agent is looking for.
export const DEFAULT_RESOURCE_TYPES = new Set(["XHR", "Fetch", "Document", "WebSocket", "EventSource"]);
export const MAX_ENTRIES = 300;
export const MAX_BODY_CHARS = 20000;
