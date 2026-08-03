// Optional content script for DOM extraction if we don't use CDP
function extractData(): Record<string, any> {
  return {
    url: window.location.href,
    title: document.title,
    html: document.documentElement.outerHTML
  };
}
