# TEST_PLANS.md — Kế Hoạch Kiểm Thử Toàn Diện MCP `browsercontrol-dev`

> Tài liệu này viết cho agent thực thi test (agy). Đọc hết mục 0-2 trước khi
> chạy bất cứ gì. Không được tự ý bỏ qua mục 5 (Regression), mục 6-9
> (Stress/Concurrency/MV3-lifecycle/Soak) hay nộp báo cáo thiếu bằng chứng
> thô theo mục 14 — báo cáo không kèm bằng chứng thô sẽ bị coi là không hợp
> lệ và phải làm lại.

Ngày tạo: 2026-08-22, cập nhật lần 2 (mở rộng sâu hơn phần fault-injection,
concurrency, MV3 lifecycle, soak test, và benchmark ở mức thống kê +
protocol-level thay vì chỉ đo điểm đơn). Chốt theo trạng thái repo tại thời
điểm viết — xem mục 1 để xác nhận trạng thái đó chưa đổi trước khi bắt đầu.

---

## 0. Cách dùng tài liệu này

- Mục 3 là **nguồn sự thật duy nhất** cho "coverage 100%" — liệt kê từng
  giá trị enum thật lấy trực tiếp từ `app/server/src/libs/gateways.ts` và
  `modules/tools/schemas.ts`, không phải danh sách tự nhớ. Một action/enum
  value nào trong mục 3 không có dòng PASS/FAIL tương ứng trong báo cáo cuối
  = **chưa đạt 100%**, bất kể tổng số "X/X PASS" ghi thế nào.
- Mục 4 cho request JSON cụ thể — không tự chế input.
- Mục 5 (Regression) **bắt buộc** — tái hiện đúng 3 bug thật đã tìm & vá
  trong phiên làm việc trước tài liệu này. Fail ở đây = fix đã bị mất trong
  lúc refactor, báo ngay, đừng report PASS cho gateway liên quan.
- Mục 6-9 (**mới, bắt buộc**) — test sâu hơn happy-path: fault injection,
  concurrency/multi-tab, vòng đời MV3 service worker, và soak test dài hơi.
  Đây là phần trả lời trực tiếp yêu cầu "test sâu hơn" — 2 báo cáo trước
  chỉ test happy-path, chưa từng thử điều gì đi sai.
- Mục 10-12 (**benchmark, nâng cấp**) — thay số đo điểm đơn/mô tả suông
  bằng phương pháp thống kê (N lần lặp, percentile), đo đúng đối tượng, và
  đo ở mức protocol (WS round-trip thật, binary framing thật) thay vì tin
  vào con số agy tự công bố trong plan.
- Mục 13 là runbook điều tra bất thường — áp dụng cho MỌI bất thường phát
  hiện ở bất kỳ mục nào trong tài liệu, không riêng benchmark.
- Mục 14 là format báo cáo bắt buộc, mục 15 là checklist ký xác nhận.

---

## 1. Điều kiện tiên quyết — ổn định môi trường trước khi test

Repo đang trong quá trình refactor lớn ("Thin Extension — Smart Server"),
**đang bị sửa trực tiếp trên working tree hiện tại** (không có worktree
riêng). Test chạy trên một cây code còn đang di chuyển sẽ cho kết quả
không tái lập được.

**Trước khi chạy bất kỳ test nào:**

1. `git status --short` phải sạch — commit hoặc stash hết thay đổi dở dang
   trước, với message mô tả đúng nội dung (không viết "fix lint" cho một
   commit chứa behavior fix).
2. Ghi lại `git rev-parse HEAD` vào đầu báo cáo cuối cùng — mọi con số
   benchmark/PASS-FAIL phải gắn với đúng 1 commit hash.
3. `bun run check:all` phải sạch (0 error, 0 warning) TRƯỚC khi đo benchmark.
4. `bun run build` (extension) thành công, reload lại ở `chrome://extensions`.
5. Daemon khởi động sạch từ đầu, không phải process cũ còn giữ state —
   ghi lại thời điểm khởi động để đối chiếu RSS baseline ở Mục 10.
6. **Mới**: đóng mọi cửa sổ Chrome DevTools đang mở trên bất kỳ tab nào
   trước khi bắt đầu — `chrome.debugger` chỉ cho 1 client attach cùng lúc,
   1 cửa sổ DevTools đang mở sẽ khiến MỌI test ở Mục 3-9 fail vì lý do sai
   (xung đột debugger), không phải vì bug thật. Trừ trường hợp cố ý test
   case FI-02 ở Mục 6.

Nếu môi trường không thoả các điều trên, **dừng lại và báo cáo lý do** thay
vì chạy test trên nền không ổn định rồi báo PASS.

---

## 2. Triết lý kiểm thử — PASS nghĩa là gì

**Không được coi "gọi tool không throw exception" là PASS.** Lỗi đã xảy ra
ở 2 lần test trước: gọi `record_flow(mode:'status')` ngay sau `start` mà
không tương tác gì, thấy `stepCount:0`, chưa hề chứng minh tracker có bắt
đúng sự kiện, vẫn ghi "✅ PASS". Tương tự: 1 flow dừng ở step 1 vì
`not_found` được diễn giải là "Smart Flow Halting — tính năng bảo vệ" mà
không kiểm tra đó có phải bug navigation-timing tái phát hay không.

**Định nghĩa PASS**: một action được coi là PASS chỉ khi cả 3 điều sau đều
đúng:

1. **Input thật, không degenerate.** `type` phải gõ text thật vào input
   thật đang hiển thị, không gọi trên input rỗng/ẩn để né lỗi.
2. **Verify effect thật trên trang, không chỉ verify response.**
   `success:true` chỉ nghĩa là CDP dispatch input event không lỗi — KHÔNG
   chứng minh trang đã phản ứng đúng ý muốn.
3. **Có bằng chứng thô đính kèm.** Raw JSON response, ảnh chụp màn hình khi
   liên quan UI. Không có bằng chứng = không tính là đã test.

**Mở rộng cho Mục 6-9 (test sâu)**: PASS ở các mục fault-injection/
concurrency/lifecycle/soak KHÔNG có nghĩa "hệ thống không bao giờ lỗi" — nó
nghĩa là **hệ thống lỗi đúng cách**: thất bại có kiểm soát, thông báo rõ
ràng, tự phục hồi khi điều kiện trở lại bình thường, không rò rỉ tài
nguyên, không để lại state rác. Một action throw lỗi rõ ràng khi mất kết
nối daemon là PASS; một action hang vô thời hạn hoặc âm thầm trả kết quả
sai là FAIL, kể cả khi không throw exception nào.

---

## 3. Ma trận Coverage — nguồn sự thật (44 action + toàn bộ sub-enum)

Đếm chính xác 44 action ở cấp gateway (7+9+8+5+7+8) — nhưng con số đó
**không tính sub-enum bên trong** (shape của drag, action của flow step,
docsAction, device/network của emulate...). "PASS (7/7)" cho `browser_act`
chỉ test 1 giá trị `shape` trong 18 khả năng vẫn được tính "đủ" một cách
sai lệch nếu không tách riêng.

### 3.1 `browser_act` (7 action)

| # | action | Test bắt buộc thêm (sub-case) | Ghi chú |
|---|---|---|---|
| 1 | `click` | trên 1 phần tử thường + 1 phần tử gây **navigation thật** | Xem Mục 5.1 |
| 2 | `type` | vào input thường + vào input **trong modal/SPA vừa mở** | Xem Mục 5.2 |
| 3 | `press_key` | 1 named key (Enter/Tab/Escape) + 1 single-char | |
| 4 | `scroll` | deltaX≠0 và deltaY≠0 riêng biệt | |
| 5 | `drag` | **đủ 18 giá trị `shape`**: `straight, circle, arc, ellipse, bezier, sine, zigzag, spiral, waypoints, polygon, star, heart, flower, rectangle, box, parametric, polar, function` | Lần trước chỉ 4/18 mà báo PASS cả action — không hợp lệ |
| 6 | `evaluate` | 1 expression đọc state + 1 expression `throw` | |
| 7 | `run_flow` | plain, `explore:true`, risky-action guard | Chưa test guard ở 2 báo cáo trước |

FlowStep sub-actions (7 loại): `click, type, press_key, drag, scroll,
wait_for, assert_text`. `assert_text` chưa từng xuất hiện — bắt buộc bổ
sung.

### 3.2 `browser_inspect` (9 action)

| # | action | Test bắt buộc thêm |
|---|---|---|
| 1 | `snapshot` | plain, `compact:true`, `visual:true`, `selector:"..."` — 4 biến thể |
| 2 | `find` | text, CSS selector, XPath — 3 kiểu `query` |
| 3 | `reading_mode` | trang article + trang app UI (phải trả "no useful content") |
| 4 | `inspect_element` | phần tử có event listener gắn |
| 5 | `screenshot` | viewport + `fullPage:true`, jpeg vs `format:"png"` (so kích thước thật) |
| 6 | `select_content` | `selector` (nhiều phần tử) và `nodeId` (1 phần tử) |
| 7 | `network_requests` | mặc định + `requestId` cụ thể |
| 8 | `network_clear` | trước 1 action tạo network call |
| 9 | `peek_screen` | `screenshot:true` và không — xác nhận không side-effect |

### 3.3 `browser_session` (8 action)

| # | action | Test bắt buộc thêm |
|---|---|---|
| 1 | `navigate` | reuse tab, `newTab:true`, navigate lại 1 `tabId` — 3 biến thể |
| 2 | `list_tabs` | `scope:'workspace'` và `'all'` |
| 3 | `switch_tab` | chuyển tab, xác nhận action sau không cần `tabId` |
| 4 | `close_tab` | xác nhận `list_tabs` sau không còn tab đó |
| 5 | `set_session_name` | xác nhận tên lưu lại đúng |
| 6 | `start_recording`/`stop_recording` | ≥10s có tương tác, file `.webm` mở được |
| 7 | `get_metrics` | current session và `allSessions:true` |

### 3.4 `browser_bulk` (5 action)

| # | action | Test bắt buộc thêm |
|---|---|---|
| 1 | `batch_crawl` | ≥3 URL, xác nhận dedup khi crawl lại |
| 2 | `search` | 1 query, trả `{title,url,snippet}` |
| 3 | `deep_crawl` | `depth:2`, `task_status` không lặp kết quả cũ |
| 4 | `start_job` | ≥2 task, `extract` khác nhau |
| 5 | `task_status` | gọi lần 2 sau khi hết kết quả → `"unknown"` |

### 3.5 `browser_knowledge` (7 action, `query_docs` có 3 docsAction)

| # | action | Test bắt buộc thêm |
|---|---|---|
| 1 | `list_skills` | `domain` filter và `query` filter |
| 2 | `save_skill` | tạo mới + update, `_duplicateWarning` khi domain trùng |
| 3 | `list_flows` | |
| 4 | `save_flow` | tạo mới + overwrite by `id` + **reject case** (step thiếu selector/role+name) |
| 5 | `delete_flow` | xác nhận `list_flows` sau không còn |
| 6 | `record_flow` | xem **Mục 5.3** — round-trip thật |
| 7 | `query_docs` | `docsAction:'list'/'search'/'read'`, cả `allSessions:true` |

### 3.6 `browser_dev` (8 action)

| # | action | Test bắt buộc thêm |
|---|---|---|
| 1 | `inspect_memory` | `focus:'overview'/'dom'/'listeners'/'gc'` — 4 biến thể |
| 2 | `inspect_process` | default + `focus:'long_tasks'` |
| 3 | `analyze_har` | có/không `filter` |
| 4 | `export_har` | `includeBodies:true/false`, file mở được trong DevTools thật |
| 5 | `debug_layout` | `focus:'box_model'/'computed'/'stacking'`, `stackingReason` đúng lý do |
| 6 | `emulate` | mỗi `device` (4) × mỗi `network` (4), riêng từng trục |
| 7 | `sandbox` | `block_mutations` chặn thật + `off` cho đi thật |
| 8 | `benchmark_report` | `format:'markdown'` và `'json'` |

**Tổng coverage thật**: liệt kê đủ từng dòng trong báo cáo cuối theo đúng
bảng trên, không gộp lại thành 1 số tổng.

---

## 4. Test script chi tiết — request mẫu theo từng gateway

> Format: **Input** (JSON gọi qua MCP), **Verify** (cách xác nhận PASS theo
> Mục 2), **Evidence** (thứ phải đính kèm báo cáo).

### 4.1 `browser_act`

**AC-01 — click gây navigation thật**
```json
{"action":"click","nodeId":<id của 1 link/button thật gây chuyển trang>}
```
Verify: `inspect.snapshot` NGAY SAU, xác nhận URL/nội dung đã đổi đúng.
Evidence: snapshot trước/sau cạnh nhau.

**AC-02 — type vào input trong modal/SPA vừa mở**
```json
{"action":"click","nodeId":<nút mở search modal>}
{"action":"type","nodeId":<input trong modal>,"text":"kiểm thử 123"}
```
Verify: `inspect_element` trên đúng input, field `v` chứa đúng "kiểm thử
123" — không suy luận từ `success:true`.

**AC-03 — drag đủ 18 shape**
Verify bằng `inspect.screenshot` chụp canvas sau khi drag để xác nhận hình
dạng đúng bằng mắt.

**AC-04 — run_flow risky-action guard**
```json
{"action":"run_flow","steps":[{"action":"click","role":"button","name":"Delete Account"}]}
```
Verify: `reason:"risky_action_blocked"`, không thực thi click thật. Gọi
lại với `confirmRisky:true`, xác nhận thực thi thật lần này.

### 4.2 `browser_inspect`

**IN-01 — snapshot 4 biến thể trên cùng 1 trang**, ghi độ dài response
(ký tự) của cả 4 để verify tuyên bố "~75% token" là thật, không ước lượng.

**IN-02 — peek_screen không side-effect**
```json
{"action":"network_clear"}
{"action":"peek_screen","screenshot":true}
{"action":"network_requests"}
```
Verify: bước 3 phải rỗng.

### 4.3 `browser_session`

**SE-01 — start_recording/stop_recording round-trip thật**: ghi ≥10s có
tương tác thật, verify file `.webm` tồn tại, size > 0, mở được bằng
player/`ffprobe`.

### 4.4 `browser_bulk`

**BU-01 — batch_crawl dedup**: crawl 2 URL, crawl lại y hệt lần 2, verify
tín hiệu dedup trong response/docs block.

### 4.5 `browser_knowledge`

**KN-01 — save_flow reject case**:
```json
{"action":"save_flow","name":"test-invalid","steps":[{"action":"click"}]}
```
Verify: PHẢI bị reject với message chứa "it will never resolve at run
time". Nếu được chấp nhận — regression nghiêm trọng.

### 4.6 `browser_dev`

**DE-01 — sandbox thật sự chặn**: `mode:'block_mutations'`, submit form
POST thật, verify `network_requests` đánh dấu `blocked:true` VÀ (nếu có
quyền truy cập) server đích thật sự không nhận request.

---

## 5. Bộ Regression bắt buộc — tái hiện đúng bug đã tìm & vá

Bắt buộc chạy dù coverage Mục 3 đã đủ — đây là 3 bug thật đã xảy ra với
người dùng thật, không phải giả định lý thuyết.

### 5.1 Navigation-teardown trong `run_flow`

**Bối cảnh**: `waitForStableDom` (`app/extension/modules/wait/index.ts`)
trước đây nuốt lỗi "context destroyed" khi 1 click gây navigation thật →
step kế tiếp resolve target trên trang chưa sẵn sàng → `not_found` → flow
dừng ở step đầu. Đã vá bằng fallback chờ `chrome.tabs.onUpdated` đạt
`status:"complete"` (`NAVIGATION_FALLBACK_TIMEOUT_MS`, `wait/constants.ts`).

**Test case** (fixture thật — Datatracker):
```json
{"action":"run_flow","steps":[
  {"action":"click","selector":"a.navbar-brand","role":"a","name":"Datatracker"},
  {"action":"click","selector":"#id_name","role":"input","name":"Document name/title/RFC number"},
  {"action":"type","selector":"#id_name","text":"demo"}
]}
```
Verify: PHẢI chạy hết cả 3 step, không dừng ở step 1 với `not_found`.

### 5.2 `Input.insertText` mất input do focus bị cướp

**Bối cảnh**: `performType` trước đây không verify text có "dính" vào
input hay không. Đã vá bằng đọc lại `.value` sau khi gõ, retry 1 lần, trả
lỗi rõ ràng nếu vẫn fail (`readElementText` + khối verify trong
`performType`).

**Test case** (fixture thật — RFC-Editor search modal):
```json
{"action":"run_flow","steps":[
  {"action":"click","selector":"#menu-link-3","role":"a","name":"Search"},
  {"action":"click","selector":"#v-3-8","role":"input"},
  {"action":"type","selector":"#v-3-8","text":"media"}
]}
```
Verify: `inspect_element` trên input đó cho value = `"media"` thật. Nếu
`#v-3-8` đã đổi (ID auto-generate framework), đổi selector và ghi chú lại
— tự nó là 1 phát hiện đáng ghi nhận.

### 5.3 `record_flow` — round-trip thật

**Test case bắt buộc**: `start` → thực hiện thật ≥3 hành động (1 gây
navigation) → `status` (verify `stepCount` > 0, khớp đúng số hành động) →
`stop` (verify `steps` phản ánh đúng) → `run_flow` lại đúng steps đó, verify
chạy hết toàn bộ (áp dụng Mục 5.1 nếu có bước navigation).

---

## 6. Fault Injection — hệ thống lỗi có đúng cách không

Đây là phần trả lời trực tiếp "test sâu hơn": 2 báo cáo trước chỉ test khi
mọi thứ diễn ra đúng kịch bản. Không có bài test nào cho khi daemon chết,
mạng rớt, tab bị đóng giữa chừng, input quá khổ. Một hệ thống chỉ được coi
là kiểm thử kỹ khi biết nó phản ứng thế nào lúc mọi thứ SAI, không chỉ lúc
mọi thứ ĐÚNG.

**FI-01 — kill daemon giữa 1 run_flow đang chạy**
Chạy `run_flow` ≥5 step (mỗi step có `pageDelay` để có đủ thời gian), giữa
step 2 và 3 kill process Bun (`kill <pid>`/Task Manager). Verify: lệnh
pending không hang vô thời hạn — timeout hoặc lỗi rõ ràng. Khởi động lại
daemon, gọi `list_tabs` — verify offscreen bridge tự reconnect theo đúng
lịch exponential backoff (`INITIAL_RECONNECT_DELAY_MS=1000` nhân đôi tới
`MAX_RECONNECT_DELAY_MS=15000`) — đo timestamp thật của các lần retry
(xem log console `[offscreen] Disconnected... retrying in Nms`), không chỉ
tin là "nó tự nối lại".

**FI-02 — xung đột chrome.debugger**
Mở DevTools thật (F12) trên 1 tab, sau đó gọi bất kỳ `browser_act`/
`browser_inspect` nào nhắm vào tab đó. Verify: error message khớp đúng
`"Failed to attach debugger to tab ... If another debugger is attached,
close DevTools and retry"` (từ `background.ts`) — không phải lỗi mơ hồ
"internal error"/timeout không giải thích.

**FI-03 — đóng tab giữa flow đang chạy `wait_for`**
`run_flow` với 1 step `wait_for` timeout dài (10s) chờ 1 phần tử sẽ không
bao giờ xuất hiện, đóng tab bằng tay ở giây thứ 3. Verify: lệnh trả lỗi
trong khoảng bounded time (không treo tới hết 10s một cách vô nghĩa nếu
tab đã biến mất — nên phát hiện tab đóng sớm hơn), và `attachedTabIds`/
`lastActiveTabId` phía extension được dọn sạch (gọi `list_tabs` sau đó
không còn tham chiếu tab ma).

**FI-04 — mất mạng giữa `deep_crawl`**
Bắt đầu `deep_crawl` với ≥10 seed URL thật, tắt network adapter ở giữa
chừng. Verify: các trang đã fetch xong TRƯỚC khi mất mạng vẫn được lưu
thành docs block (không phải all-or-nothing), `task_status` báo cáo lỗi
per-URL cho các URL chưa kịp fetch thay vì crash toàn bộ job.

**FI-05 — input quá khổ / sai định dạng**
| Case | Input | Verify |
|---|---|---|
| Vượt `MAX_FLOW_STEPS` | `run_flow` với 25 step | reject sạch với message `"too_many_steps"` từ `flow/index.ts`, không chạy 20 step đầu rồi im lặng bỏ 5 step cuối |
| Vượt cap `batch_crawl` | 150 URL (doc ghi max 100) | server chặn/cắt rõ ràng, không âm thầm xử lý cả 150 hoặc crash |
| Text quá dài | `type` 50,000 ký tự | không hang/OOM; verify độ dài thật đã gõ vào field sau đó |
| `evaluate` throw | `expression:"throw new Error('x')"` | lỗi trả về sạch trong response, tab/daemon không crash |
| `nodeId` stale | `debug_layout` với nodeId từ snapshot cũ sau khi đã `navigate` | lỗi rõ ràng kiểu "stale node", không unhandled exception |

**FI-06 — SQLite bị kill giữa lúc ghi**
Bắn liên tiếp nhiều `save_flow` nhanh, `kill -9` daemon giữa chừng, khởi
động lại. Verify: `data/index.sqlite` mở lại được (không corrupt),
`list_flows` vẫn thấy các flow đã lưu thành công trước khi bị kill.

---

## 7. Concurrency & Multi-Tab Testing

**CC-01 — 2 tab, 2 luồng song song**
Mở tab A và B (`navigate({newTab:true})`), chạy `run_flow` trên A, ngay lập
tức (không đợi) gọi `snapshot` trên B kèm `tabId` tường minh. Verify: response
của B phản ánh đúng DOM của B (không lẫn dữ liệu A), flow trên A vẫn hoàn
tất đúng dù bị xen giữa bởi call khác.

**CC-02 — 2 `run_flow` đồng thời trên CÙNG 1 tab**
Bắn 2 `run_flow` không đợi cái đầu xong. Verify: daemon serialize an toàn
(1 chạy xong hết mới tới cái kia) HOẶC cái thứ 2 bị từ chối/queue rõ ràng —
không được để cả 2 xen kẽ nhau làm sai lệch trạng thái con trỏ/highlight
hoặc click nhầm phần tử của flow kia.

**CC-03 — cap concurrency của `start_job`/`batch_crawl`**
Chạy `start_job` với `tasks`/`concurrency` ở mức max tài liệu định nghĩa
đồng thời với `batch_crawl` 50 URL. Verify qua `list_tabs({scope:'all'})`
trong lúc chạy: số tab thật được mở KHÔNG BAO GIỜ vượt quá `concurrency` đã
cấu hình, và `task_status` của cả 2 job đều tiến triển (không job nào bị
đói tài nguyên hoàn toàn).

**CC-04 — recording + hành động nặng đồng thời**
`start_recording`, trong lúc ghi chạy `run_flow` có `drag` shape phức tạp
(`spiral`/`function`). Verify: file video không hỏng/đứng hình, và `drag`
vẫn hoàn tất trong thời gian bình thường (recording không làm đơ hành động
khác — đúng tuyên bố "O(1) memory" của Giai đoạn 4).

---

## 8. Vòng đời MV3 Service Worker — edge case

Mục này kiểm tra trực tiếp đúng rủi ro đã cảnh báo với Giai đoạn 3 của kế
hoạch refactor (chuyển WebSocket vào `background.ts`, bỏ qua
`offscreen/`). Dù Giai đoạn 3 hiện **chưa** áp dụng (kiểm tra lại: nếu
`background.ts` vẫn gọi `ensureOffscreenDocument()`/`chrome.offscreen.
createDocument`, nghĩa là WS vẫn ở offscreen, chưa chuyển) — bộ test này
vẫn PHẢI chạy để lập **baseline hiện tại**, và **bắt buộc chạy lại, so
sánh side-by-side** ngay khi Giai đoạn 3 được áp dụng thật, vì đây đúng là
lớp lỗi một cuộc migrate service-worker cẩu thả dễ tái tạo nhất.

**SW-01 — sống sót qua idle timeout**
Kết nối daemon xong, để Chrome hoàn toàn idle (không tương tác tab/
extension nào) ≥6 phút. Gọi `list_tabs`. Verify: phản hồi thành công, không
phải lỗi "Unknown command"/mất kết nối — chứng minh nơi giữ WS (offscreen
hiện tại, hoặc background.ts sau Giai đoạn 3) sống sót qua SW suspension.

**SW-02 — buộc kill service worker thủ công**
Qua `chrome://serviceworker-internals` (hoặc `chrome://inspect/#service-
workers`), tìm SW của extension, bấm "Terminate" khi đang có session hoạt
động. Gọi ngay 1 tool call. Verify: (a) hoạt động xuyên suốt (SW respawn
tự động, không ảnh hưởng WS), hoặc (b) fail đúng 1 lần với thông báo
reconnect rõ ràng rồi thành công ở lần retry kế — KHÔNG được hang im lặng
hoặc mất kết nối vĩnh viễn cần reload thủ công cả extension.

**SW-03 — chu kỳ sleep/wake**
Cho máy sleep (hoặc tắt network adapter mô phỏng) ≥2 phút giữa session
đang hoạt động, rồi wake/bật lại. Đo thời gian thật từ lần gọi lỗi đầu
tiên tới lần gọi thành công đầu tiên sau khi wake, đối chiếu với lịch
exponential backoff thật của `OffscreenDaemonBridge` (1s→2s→4s→8s→15s,
cap ở `MAX_RECONNECT_DELAY_MS`). Lệch nhiều so với lịch này (quá nhanh =
hot-loop reconnect, guard `isDisposed`/state có bug; quá chậm = backoff
logic tính sai) đều là bug cần báo.

**SW-04 — reload extension giữa session**
Reload thủ công ở `chrome://extensions` trong lúc `run_flow`/recording
đang chạy. Verify: không còn debugger session zombie gắn vào tab cũ (thử
attach lại sau reload — phải thành công, không báo "already attached"), và
daemon phát hiện đúng việc mất kết nối (không giữ tham chiếu cũ nuốt mọi
lệnh sau đó trong im lặng).

**SW-05 — nhiều cửa sổ Chrome cùng lúc**
Mở cửa sổ Chrome thứ 2, mở side panel ở đó. Verify: chỉ tồn tại DUY NHẤT 1
offscreen document / 1 kết nối WS toàn extension (offscreen document là
extension-wide, không phải per-window) — lệnh từ side panel ở cửa sổ nào
cũng đi qua đúng 1 kết nối daemon chung, không tranh chấp/nhân đôi.

---

## 9. Soak Test — ổn định qua thời gian dài

**ST-01**: chạy liên tục ≥2 giờ 1 kịch bản lặp (navigate → snapshot →
click → type → run_flow 5 bước → screenshot), lặp mỗi 30s. Lấy mẫu RAM
(extension theo Mục 10.1, daemon theo Mục 10.2) mỗi 5 phút → tối thiểu 24
điểm dữ liệu.

**ST-02**: fit linear regression qua các điểm (thời gian vs RAM). Hệ số
góc phải xấp xỉ 0 sau 10 phút warm-up đầu. Slope dương rõ rệt, ổn định
(không phải nhiễu quanh 0) = leak thật, điều tra theo Mục 13.

**ST-03**: theo dõi riêng `Active DOM Nodes`/`Active Event Listeners`
(`dev.inspect_memory({focus:'dom'/'listeners'})`) qua từng chu kỳ
`navigate` — phải trở về baseline sau mỗi lần navigate sang trang mới,
không cộng dồn từ trang cũ. Tăng dần không giảm qua nhiều chu kỳ = listener
của chính extension (recorder/interceptor/network module) không được dọn
khi rời trang — đúng lớp bug lifecycle mà `OffscreenDaemonBridge.dispose()`
đã phải vá cho chính kết nối WS; các module khác cần được soi cùng kiểu.

**ST-04**: theo dõi log kết nối WS suốt 2 giờ — không được có
`[offscreen] Disconnected from daemon` xuất hiện vô cớ (không do sleep/
network cut chủ động). Nếu có, đó là dấu hiệu SW-01..05 đang fail âm thầm
ở điều kiện thực tế mà test ngắn không bắt được.

---

## 10. Benchmark tài nguyên — thống kê đúng cách, đúng đối tượng

### 10.0 Nguyên tắc thống kê bắt buộc (mới)

Báo cáo trước đưa **1 con số hoặc 1 khoảng** (vd "105.31 MB – 117.16 MB")
không nói rõ N lần đo, không phân biệt cold/warm start. Từ nay:

- Mỗi metric đo **N ≥ 30 lần**, báo cáo **p50/p95/p99/max**, không chỉ
  min-max hoặc trung bình đơn.
- **Bỏ qua 3 lần đo đầu tiên** sau khi khởi động (cold start/JIT warm-up
  làm lệch số) — chỉ tính thống kê từ lần thứ 4 trở đi, nhưng vẫn báo cáo
  riêng 3 lần đầu để so sánh cold vs warm.
- Mọi con số phải kèm **N, thời điểm đo, commit hash** — 1 con số đứng một
  mình không có ngữ cảnh này không được chấp nhận trong báo cáo cuối.

### 10.1 Memory — extension (đúng đối tượng)

1. `chrome://extensions` → Developer mode → browsercontrol-dev → click
   "service worker" → DevTools riêng cho SW → tab Memory → "Take heap
   snapshot".
2. Lặp lại cho "offscreen.html" nếu có trong danh sách views — nơi giữ
   WebSocket + MediaRecorder, quan trọng nhất cần đo.
3. Đo tại 3 thời điểm: (a) ngay sau load, idle; (b) sau khi chạy hết Mục
   3-9; (c) sau idle thêm 5 phút — so sánh (b)/(c) để phát hiện leak (số
   không giảm sau GC = dấu hiệu leak).
4. Ghi rõ Chrome version, OS.

### 10.2 Memory — daemon (Bun)

OS-level (`ps`/Task Manager), không qua MCP tool nào — hiện chưa có action
nào trả RSS của chính process daemon. Đo tại 3 mốc giống 10.1.

### 10.3 CPU (thiếu hoàn toàn ở 2 báo cáo trước)

1. Trong lúc chạy Mục 3-9, lấy %CPU của Chrome (tab renderer + SW) và Bun
   ở các mốc 30s.
2. Báo trung bình VÀ đỉnh trong lúc `drag` chạy shape phức tạp (`spiral`,
   `function`) — nơi khả năng cao nhất tốn CPU tính trajectory.
3. Nếu Giai đoạn 1 (trajectory tính ở server) đã hoàn tất thật (kiểm tra
   `actions/index.ts` chỉ còn `import type { Point }`, không import hàm
   runtime nào từ `@browsercontrol/shared`) — %CPU phía Chrome lúc drag
   phải thấp hơn rõ rệt so với baseline trước refactor (Mục 10.4). Không
   có baseline để so → ghi rõ "chưa verify được", đừng suy luận.

### 10.4 So sánh trước/sau refactor — comparative baseline (mới)

Mọi con số cải thiện agy tuyên bố trong kế hoạch refactor ("giảm 22KB",
"nhanh 5-10x", "giảm 33.3% dung lượng", "nhanh gấp 11 lần") đều **không
verify được nếu không có baseline "trước" để so** — đây là lỗ hổng lớn
nhất của 2 báo cáo trước, chúng chỉ đo "sau" mà không có "trước" để đối
chứng.

1. Xác định commit trước khi Giai đoạn 1 bắt đầu (`git log` tìm commit
   ngay trước dòng đầu tiên trong `git log -- app/extension/modules/
   geometry/` bị xoá — hoặc dùng `fd71fe6`/`3a217cd` như điểm neo gần nhất
   đã biết trong lịch sử).
2. `git worktree add ../browsercontrol-baseline <commit-đó>` — build và
   chạy daemon từ worktree này, **song song** với worktree hiện tại (2
   daemon 2 port khác nhau).
3. Chạy **đúng bộ test Mục 3 + benchmark Mục 10.1-10.3** trên CẢ HAI, cùng
   1 máy, cùng thời điểm gần nhau (tránh nhiễu do máy đang làm việc khác).
4. Báo cáo bảng so sánh side-by-side: RAM/CPU/latency trước vs sau, %
   thay đổi thật — đối chiếu trực tiếp với từng con số agy đã tuyên bố
   trong kế hoạch refactor, ghi rõ tuyên bố nào được xác nhận, tuyên bố
   nào không đạt, tuyên bố nào chưa đo được.

---

## 11. Benchmark token economics — đo trung thực

Hai báo cáo trước có cùng 1 con số "~16,200 tokens" cho Docs Blocks ở 2
phiên khác quy mô (60 call vs 80 call) — dấu hiệu số bị copy lại. Quy
trình bắt buộc:

1. Gọi `get_metrics`/`benchmark_report` **ngay đầu phiên** — baseline 0.
2. Sau MỖI action Mục 3-9, ghi token count riêng của lệnh đó (từ response
   thật, không cộng dồn ước lượng).
3. Cuối phiên, gọi lại — tổng phải khớp (sai số ≤5%) với tổng cộng dồn ở
   bước 2. Lệch nhiều hơn → bug ở chính cơ chế đo token, báo riêng.
4. Định nghĩa rõ "baseline không tối ưu" dùng để tính % tiết kiệm — gọi
   thật 1 lần `snapshot` không `compact`/`selector` để lấy baseline thật,
   không phải số lý thuyết.
5. Không làm tròn số liệu — dùng đúng số integer, kèm timestamp từng lần
   gọi `get_metrics`.

---

## 12. Benchmark mức Protocol — kiểm chứng số liệu Giai đoạn 3-4 của refactor

Kế hoạch refactor tuyên bố các con số rất chính xác ("24.5ms → 2.1ms",
"+33.3% Base64", "0ms lag") mà không có phương pháp đo kèm theo — cần đo
lại thật thay vì tin theo.

**PB-01 — phân phối round-trip WebSocket thật**
Chèn timestamp `t0` (client) vào 1 lệnh nhẹ (`list_tabs`), ghi `t1` lúc
response về, lặp N=100. Báo cáo p50/p95/p99/max thật, so với con số
"≤2.1ms" đã tuyên bố — không chọn 1 lần đo đẹp nhất. Đo cả trước và sau khi
Giai đoạn 3 (WS trực tiếp trong `background.ts`) được áp dụng để thật sự
định lượng mức cải thiện tuyên bố "nhanh gấp 11 lần" — hiện chưa báo cáo
nào định lượng được con số này.

**PB-02 — binary framing vs JSON, đo thật**
Với 1 screenshot thật (`inspect.screenshot`): đo (a) kích thước payload
base64-trong-JSON (hiện tại), (b) kích thước payload binary opcode framing
(khi Giai đoạn 3 phần binary protocol lên) — báo byte thật, không dùng con
số "+33.3%" trong plan làm số liệu báo cáo. Đo thêm thời gian CPU
encode/decode thật ở cả 2 phía (client + server) cho cả 2 cách.

**PB-03 — độ trễ pipeline video chunk**
Với `start_recording`: đo thời gian thật (wall-clock) từ lúc `MediaRecorder`
phát ra 1 chunk (timestamp phía extension) tới lúc `streamSink.
appendVideoChunk` ghi xong xuống đĩa (timestamp phía daemon) — verify claim
"0ms lag khi stop" của Giai đoạn 4, và verify nhịp chunk 500ms có thật sự
đều đặn (~500ms ± 50ms giữa các chunk, không dồn cục/bursty).

---

## 13. Runbook điều tra bất thường

Áp dụng cho MỌI bất thường phát hiện ở bất kỳ mục nào (Mục 6-9 fault/
concurrency/lifecycle/soak, hay Mục 10-12 benchmark) — không riêng số liệu
hiệu năng.

1. **Tái hiện lại** — chạy lại đúng test 3 lần liên tiếp. Ổn định hay dao
   động mạnh (dao động mạnh → yếu tố ngẫu nhiên/race condition)?
2. **Cô lập biến** — thử trên 1 trang/kịch bản tối giản để tách bạch chi
   phí của chính cơ chế đo/hạ tầng khỏi chi phí của trang/kịch bản test.
3. **Đối chiếu nguồn gốc** — với benchmark: mở DevTools Performance tab
   thật, record cùng thao tác, so với số MCP trả về. Với fault-injection:
   đối chiếu console log thật (`[offscreen]`/daemon log) với hành vi quan
   sát được qua MCP response.
4. **Truy vết theo code** — nếu số liệu/hành vi đúng và ổn định (không do
   đo sai), tìm trong code phần nào gây ra, phân biệt rõ "do chính
   browsercontrol" hay "do đặc tính trang/kịch bản test".
5. **Ghi root cause cụ thể**, không dùng nhãn mơ hồ ("Healthy"/"Moderate")
   không kèm số so sánh/lý do. Không tìm ra sau 4 bước trên → ghi thẳng
   "chưa xác định được nguyên nhân, cần điều tra thêm" — câu trả lời trung
   thực, chấp nhận được, tốt hơn nhãn "bình thường" không cơ sở.

---

## 14. Format báo cáo bắt buộc

1. **Commit hash + thời điểm bắt đầu/kết thúc test.**
2. **Bảng coverage đầy đủ** theo đúng cấu trúc Mục 3 — từng dòng riêng cho
   từng sub-enum.
3. **Bằng chứng thô** cho mỗi test case — raw JSON, đường dẫn file thật đã
   verify tồn tại/mở được.
4. **Kết quả riêng Mục 5 (Regression)** — PASS/FAIL từng case.
5. **Kết quả riêng Mục 6-9 (Fault Injection/Concurrency/MV3 lifecycle/
   Soak)** — mỗi test case 1 dòng PASS/FAIL/PARTIAL kèm mô tả hành vi quan
   sát được, không gộp chung coverage tổng.
6. **Số liệu benchmark theo Mục 10-12** — kèm N, percentile, raw OS-level
   data, bảng so sánh trước/sau refactor (Mục 10.4).
7. **Danh sách bất thường + root cause** theo Mục 13.
8. **Danh sách thay đổi code phát sinh trong lúc test**, commit riêng,
   message đúng nội dung.

---

## 15. Checklist ký xác nhận Coverage 100%

- [ ] 44/44 action cấp gateway (Mục 3.1-3.6), mỗi action ≥1 bằng chứng thô
- [ ] 18/18 giá trị `drag.shape`
- [ ] 7/7 loại `FlowStep.action`
- [ ] 4/4 biến thể `snapshot`, 3/3 `docsAction`
- [ ] 4/4 `emulate.device`, 4/4 `emulate.network`
- [ ] 3/3 `debug_layout.focus`
- [ ] `run_flow` risky-action guard + `save_flow` reject-case
- [ ] Mục 5.1, 5.2, 5.3 — PASS trên fixture thật
- [ ] Mục 6 (Fault Injection) — FI-01 đến FI-06, tất cả có kết luận
- [ ] Mục 7 (Concurrency) — CC-01 đến CC-04
- [ ] Mục 8 (MV3 lifecycle) — SW-01 đến SW-05, có baseline trước Giai đoạn 3
- [ ] Mục 9 (Soak ≥2 giờ) — ST-01 đến ST-04, có đồ thị/số liệu regression
- [ ] Mục 10 (RAM/CPU, N≥30, percentile, so sánh trước/sau refactor thật)
- [ ] Mục 11 (token economics, đối chiếu tổng vs cộng dồn)
- [ ] Mục 12 (protocol-level: WS RTT thật, binary framing thật, video
      pipeline latency thật) — không dùng số trong plan làm số liệu báo cáo
- [ ] Mọi bất thường có root cause hoặc ghi nhận "chưa xác định" rõ ràng
