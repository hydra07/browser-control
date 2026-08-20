import { useCallback, useEffect, useState } from "react";
import { listFlows, type FlowMeta } from "./lib/api";
import { FlowList } from "./components/FlowList";

type LoadState =
    | { status: "loading" }
    | { status: "loaded"; flows: FlowMeta[] }
    | { status: "unreachable"; message: string };

// Polled, not pushed — there's no notification channel from the daemon into
// this panel (same reasoning as browser_list_tabs' isNew flag: MCP/HTTP here
// is all pull-based), so a plain interval is the simplest way for a flow
// saved from another session to show up without a manual refresh click.
const POLL_MS = 5000;

export default function App() {
    const [state, setState] = useState<LoadState>({ status: "loading" });

    const load = useCallback(async () => {
        try {
            const flows = await listFlows();
            setState({ status: "loaded", flows });
        } catch (e) {
            setState({
                status: "unreachable",
                message: e instanceof Error ? e.message : String(e),
            });
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    return (
        <div className="app">
            <header className="app-header">
                <span className="app-title">🤖 Flows</span>
                <button className="refresh-button" onClick={() => void load()} title="Refresh">
                    ↻
                </button>
            </header>
            {state.status === "loading" && <div className="empty-state">Loading…</div>}
            {state.status === "unreachable" && (
                <div className="empty-state empty-state-error">{state.message}</div>
            )}
            {state.status === "loaded" && <FlowList flows={state.flows} />}
        </div>
    );
}
