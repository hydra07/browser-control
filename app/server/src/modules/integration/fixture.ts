const FIXTURE_HOST = "127.0.0.1";

const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BrowserControl Integration Fixture</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    body { margin: 2rem auto; max-width: 52rem; padding: 0 1rem; }
    fieldset { display: grid; gap: .75rem; margin: 1rem 0; padding: 1rem; }
    .duplicate-targets { display: flex; gap: .75rem; }
    output { display: block; min-height: 1.5rem; margin-top: 1rem; font-family: monospace; }
  </style>
</head>
<body>
  <main>
    <h1>BrowserControl integration fixture</h1>
    <p>This page is local-only and exists to exercise the real Chrome bridge.</p>

    <fieldset aria-label="Unique controls">
      <legend>Unique controls</legend>
      <button id="unique-action" aria-label="Unique action"
        onclick="document.querySelector('#fixture-status').textContent='clicked'">
        Unique action
      </button>
      <label>Name input <input id="name-input" name="displayName" aria-label="Name input"
        oninput="document.querySelector('#fixture-status').textContent='typed:' + this.value"></label>
      <label>Key input <input id="key-input" name="keyTarget" aria-label="Key input"
        onkeydown="if (event.key === 'Enter') document.querySelector('#fixture-status').textContent='pressed:' + event.key"></label>
      <button id="rerender-control" aria-label="Rerender target">Rerender target</button>
    </fieldset>

    <fieldset aria-label="Duplicate controls">
      <legend>Duplicate controls</legend>
      <div class="duplicate-targets">
        <button aria-label="Duplicate target">Duplicate target A</button>
        <button aria-label="Duplicate target">Duplicate target B</button>
      </div>
    </fieldset>

    <fieldset aria-label="Sensitive controls">
      <legend>Sensitive controls</legend>
      <label>Password input <input id="password-input" type="password" autocomplete="current-password"
        aria-label="Password input"></label>
    </fieldset>

    <output id="fixture-status" role="status" aria-label="Action status">idle</output>
  </main>
</body>
</html>`;

const NAVIGATION_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>BrowserControl Navigation Target</title></head>
<body><main><h1>Navigation target</h1><p>Navigation completed.</p></main></body>
</html>`;

export interface FixtureServer {
  url: string;
  stop(): Promise<void>;
}

/** Starts a disposable local page with deterministic controls for real-browser smoke tests. */
export function startFixtureServer(requestedPort = 0): FixtureServer {
  const server = Bun.serve({
    hostname: FIXTURE_HOST,
    port: requestedPort,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/fixture" || pathname === "/fixture/") {
        return new Response(FIXTURE_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (pathname === "/fixture/next") {
        return new Response(NAVIGATION_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (pathname === "/health") return new Response("ok\n");
      return new Response("Not found\n", { status: 404 });
    },
  });

  return {
    url: `http://${FIXTURE_HOST}:${server.port}/fixture`,
    stop: () => server.stop(true),
  };
}
