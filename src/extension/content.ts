// Optional content script for DOM extraction if we don't use CDP
function extractData(): { url: string; title: string; html: string } {
  return {
    url: window.location.href,
    title: document.title,
    html: document.documentElement.outerHTML
  };
}
