package main

import (
	"fmt"
	"os"
)

// Release builds override this with -ldflags "-X main.version=vX.Y.Z".
var version = "dev"

func main() {
	os.Exit(runCLI(os.Args[1:]))
}

const usage = `browsercontrol extension - legacy extension adapter (track X)

Usage: browsercontrol extension <command> [args] [--flags]

Look (cheapest first):
  snapshot [--grep txt] [--region css]   interactive nodes: "[id] role "name"" (default 80; --limit 0 = all)
  snapshot --semantic [--diff]           document-scoped refs (e12); --diff = changes since last
  find <text|css|xpath> [--limit n]      matching nodes with ids + context
  read [--max-chars 12000]               article text
  select <css> [--max-chars n]           markdown of matching elements
  peek [--out shot.jpg]                  url/title/visible text of the focused tab
  inspect <target>                       element box/styles/attributes
  screenshot [file] [--full|--target t|--clip x,y,w,h] [--zoom n]   saves, prints path+size
  visual [file]                          annotated screenshot + node list
Act (target = snapshot id | e<ref> | css | text):
  open <url> [--new-tab] [--background]  back | forward | reload
  click <target> [--confirm-risky]       type <target> <text> [--clear]   fill <target> <text>
  press <key|Control+a> [target]         scroll [dy|up|down] [--in t]     drag x1 y1 x2 y2   eval <js>
  wait <text|css> [--gone] [--timeout 15s]
  Add --snap to any action to print a fresh snapshot after it (saves a round trip).
Batch (one process, stops at first error):
  do "click 12" "type 14 'hi there'" "press Enter" snapshot
  do -        read one command per line from stdin
Tabs/network/dev:
  tabs [list [--all]|switch <id>|close <id>|new <url>]
  net [list [--filter s] [--limit n]|detail <id> [--body]|clear|har]
  dev layout|memory|process|emulate|sandbox|har [...]
  flow run|explore|validate <file.json|saved-id> | flow record|stop|status
  search <query>      crawl <url...|@urls.txt>      capture start|stop      evidence
Bridge:
  status [--wait 20s]    serve    token    exec <raw_cmd> [key=value|--k v|@payload.json]
  cdp <command>          direct CDP mode, bypasses the extension (debug only)

Flags: --json (compact JSON) --tab <id> --timeout 30s --token-file <path>
       --port 8765 --session-id <id>
Exit: 0 ok, 1 command/extension error (message + hint on stderr), 2 usage error.
Run 'browsercontrol help <command>' for details.
Run 'browsercontrol help agent' for the short observe/act/verify/recover loop.
`

func printUsage() { fmt.Print(usage) }
