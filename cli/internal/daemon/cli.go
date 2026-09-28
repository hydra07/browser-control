package daemon

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

func HandleDaemon(args []string, cfg Config, asJSON bool) error {
	subcmd := "status"
	if len(args) > 0 {
		subcmd = args[0]
	}

	switch subcmd {
	case "help", "-h", "--help":
		printDaemonUsage()
		return nil
	case "status":
		return requestAndPrint(cfg, "GET", "/status", nil, asJSON)
	case "metrics":
		path := "/metrics"
		if len(args) > 1 {
			path = "/metrics?sessionId=" + url.QueryEscape(args[1])
		}
		return requestAndPrint(cfg, "GET", path, nil, asJSON)
	case "execute", "exec":
		return HandleExecute(args[1:], cfg, asJSON)
	case "raw":
		return handleRaw(args[1:], cfg, asJSON)
	default:
		return fmt.Errorf("unknown daemon subcommand %q (supported: status, metrics, execute, raw)", subcmd)
	}
}

func HandleExecute(args []string, cfg Config, asJSON bool) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: browsercontrol exec <server-command> [@payload.json|inline-json|key=value ...]")
	}
	cmd := NormalizeCommandName(args[0])
	if !IsKnownCommand(cmd) {
		return fmt.Errorf("unknown server command %q", args[0])
	}
	payload, err := ParsePayloadArgs(args[1:])
	if err != nil {
		return err
	}
	payload["cmd"] = cmd
	return requestAndPrint(cfg, "POST", "/execute", payload, asJSON)
}

func HandleFlows(args []string, cfg Config, asJSON bool) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		printFlowsUsage()
		return nil
	}

	subcmd := args[0]
	switch subcmd {
	case "list", "ls":
		return requestAndPrint(cfg, "GET", "/flows", nil, asJSON)
	case "get", "show":
		if len(args) < 2 {
			return fmt.Errorf("usage: browsercontrol flows get <flow-id>")
		}
		return requestAndPrint(cfg, "GET", "/flows/"+escapePathPart(args[1]), nil, asJSON)
	case "save", "create", "add":
		if len(args) < 2 {
			return fmt.Errorf("usage: browsercontrol flows save <@flow.json|flow.json|inline-json|key=value ...>")
		}
		payloadArgs := args[1:]
		if len(payloadArgs) == 1 && !strings.HasPrefix(payloadArgs[0], "@") && !strings.Contains(payloadArgs[0], "=") && !strings.HasPrefix(strings.TrimSpace(payloadArgs[0]), "{") {
			payloadArgs[0] = "@" + payloadArgs[0]
		}
		payload, err := ParsePayloadArgs(payloadArgs)
		if err != nil {
			return err
		}
		return requestAndPrint(cfg, "POST", "/flows", payload, asJSON)
	case "delete", "rm":
		if len(args) < 2 {
			return fmt.Errorf("usage: browsercontrol flows delete <flow-id>")
		}
		return requestAndPrint(cfg, "DELETE", "/flows/"+escapePathPart(args[1]), nil, asJSON)
	case "run":
		if len(args) < 2 {
			return fmt.Errorf("usage: browsercontrol flows run <flow-id>")
		}
		return requestAndPrint(cfg, "POST", "/flows/"+escapePathPart(args[1])+"/run", nil, asJSON)
	default:
		return fmt.Errorf("unknown flows subcommand %q (supported: list, get, save, delete, run)", subcmd)
	}
}

func HandleAgent(args []string, cfg Config, asJSON bool) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		printAgentUsage()
		return nil
	}

	subcmd := args[0]
	switch subcmd {
	case "status":
		return requestAndPrint(cfg, "GET", "/cli-agent/status", nil, asJSON)
	case "abort", "cancel":
		return requestAndPrint(cfg, "POST", "/cli-agent/abort", nil, asJSON)
	case "query", "ask":
		if len(args) < 2 {
			return fmt.Errorf("usage: browsercontrol agent query <prompt> [key=value ...]")
		}
		body, err := ParsePayloadArgs(args[2:])
		if err != nil {
			return err
		}
		body["prompt"] = args[1]
		return requestAndPrint(cfg, "POST", "/cli-agent/query", body, asJSON)
	case "stream":
		if len(args) < 2 {
			return fmt.Errorf("usage: browsercontrol agent stream <prompt> [key=value ...]")
		}
		body, err := ParsePayloadArgs(args[2:])
		if err != nil {
			return err
		}
		body["prompt"] = args[1]
		client, err := NewClient(cfg)
		if err != nil {
			return err
		}
		data, _, err := client.Request("POST", "/cli-agent/stream", body)
		if err != nil {
			return err
		}
		fmt.Print(string(data))
		return nil
	default:
		return fmt.Errorf("unknown agent subcommand %q (supported: status, query, stream, abort)", subcmd)
	}
}

func requestAndPrint(cfg Config, method, path string, body any, asJSON bool) error {
	client, err := NewClient(cfg)
	if err != nil {
		return err
	}
	data, _, err := client.Request(method, path, body)
	if err != nil {
		return err
	}
	if asJSON {
		PrintJSONBytes(data)
		return nil
	}
	PrintJSONBytes(data)
	return nil
}

func handleRaw(args []string, cfg Config, asJSON bool) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: browsercontrol daemon raw <GET|POST|DELETE|...> <path> [@payload.json|inline-json|key=value ...]")
	}
	method := strings.ToUpper(args[0])
	path := args[1]
	var body any
	if len(args) > 2 {
		payload, err := ParsePayloadArgs(args[2:])
		if err != nil {
			return err
		}
		body = payload
	}
	return requestAndPrint(cfg, method, path, body, asJSON)
}

func printDaemonUsage() {
	fmt.Fprintln(os.Stderr, `Usage:
  browsercontrol daemon status
  browsercontrol daemon metrics [session-id]
  browsercontrol daemon execute <server-command> [@payload.json|key=value ...]
  browsercontrol daemon raw <METHOD> <path> [@payload.json|key=value ...]

All calls authenticate against the local BrowserControl daemon using --token,
--token-file, BROWSERCONTROL_AUTH_TOKEN, or data/daemon-auth-token.`)
}

func printFlowsUsage() {
	fmt.Fprintln(os.Stderr, `Usage:
  browsercontrol flows list
  browsercontrol flows get <flow-id>
  browsercontrol flows save <flow.json|@flow.json|inline-json|key=value ...>
  browsercontrol flows delete <flow-id>
  browsercontrol flows run <flow-id>`)
}

func printAgentUsage() {
	fmt.Fprintln(os.Stderr, `Usage:
  browsercontrol agent status
  browsercontrol agent query <prompt> [agentId=claude|agy] [effort=low|medium|high]
  browsercontrol agent stream <prompt> [agentId=claude|agy] [effort=low|medium|high]
  browsercontrol agent abort`)
}
