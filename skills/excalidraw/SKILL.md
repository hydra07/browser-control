---
name: excalidraw
domains:
  - excalidraw.com
description: Live excalidrawAPI scene control via browser_evaluate (element skeletons, complete scenic art/paintings, text/arrow/group/frame binding rules), CRUD on existing drawings, spacious layout guidelines, and diagramming rules for Excalidraw
---
# Excalidraw Interaction & Art Creation Skill

## Domain
- `excalidraw.com`

## Overview
Excalidraw is a virtual collaborative whiteboard, illustration, and diagramming tool. It supports drawing structured geometric shapes, freehand artistic paths, text in handwriting fonts (Virgil), sticky notes, arrows, and rich styling (stroke style, sloppiness, fill styles, color palettes).

---

## ⚠️ QUY TẮC SỐNG CÒN KHI VẼ TRANH HOẶC VẼ BIỂU ĐỒ (CRITICAL)

1. **TUYỆT ĐỐI KHÔNG DÙNG PHÍM `P` VÀ DRAG QUẸT NÉT BÚT CHÌ TỰ DO**:
   - Việc chuyển sang Pen (`P`) rồi quẹt chuột vài nét ngẫu nhiên tạo ra các nét vẽ nguệch ngoạc, đứt đoạn, mất thẩm mỹ và không phải một bức tranh.
2. **LUÔN DÙNG `window.excalidrawAPI.updateScene` LÀM PHƯƠNG THỨC CHÍNH**:
   - Cả vẽ tranh nghệ thuật (phong cảnh, chân dung, đồ vật) lẫn vẽ biểu đồ (flowchart, architecture) đều được tạo trực tiếp qua `updateScene` với các đối tượng hình học hoàn chỉnh, phân tầng màu sắc, fill đa dạng và tọa độ chuẩn xác.

---

## 🎨 1. Quy chuẩn Vẽ Tranh Nghệ Thuật Hoàn Chỉnh (Scenic Art & Illustration Masterpiece)

Khi được yêu cầu vẽ tranh (phong cảnh, hoàng hôn, núi non, hoa lá, nhân vật, thành phố...), Agent **bắt buộc** phải xây dựng một bức tranh hoàn chỉnh có cấu trúc đa tầng (Multi-layered Artwork):

### Cấu trúc 5 tầng của một bức tranh hoàn chỉnh:
1. **Hậu cảnh & Bầu trời (Sky & Atmosphere)**:
   - Nền trời hoặc khung không gian (`rectangle` lớn hoặc viền tranh).
   - Mặt trời / Mặt trăng (`ellipse`, `backgroundColor: "#f59e0b"`, `fillStyle: "solid"`).
   - Mây trôi mềm mại (chuỗi 3-4 `ellipse` trắng lồng vào nhau, `backgroundColor: "#ffffff"`, `fillStyle: "solid"`).
   - Đàn chim bay trên bầu trời (`line` dạng chữ V lượn sóng `[[0, 10], [15, 0], [30, 10]]`).
2. **Dãy núi & Trung cảnh (Mountains & Architecture)**:
   - Dãy núi xa / gần (`line` khép kín đa đỉnh hoặc `diamond`, `fillStyle: "hachure"`, `strokeColor: "#475569"`, đỉnh núi phủ tuyết).
   - Công trình / Nhà cửa (thân nhà `rectangle`, mái ngói `diamond` đỏ `#ef4444`, cửa sổ `rectangle` vàng sáng `#fde047`, ống khói).
3. **Tiền cảnh & Thiên nhiên (Foreground & Nature)**:
   - Cây cối / Hoa cỏ: Thân cây (`rectangle` nâu `#78350f`), Tán lá (`ellipse` tròn hoặc cụm ellipse xanh `#15803d` với `fillStyle: "zigzag"`).
   - Thảm cỏ xanh mát (`rectangle` xanh nền kèm các cụm cỏ nhỏ `line`).
   - Dòng sông / Hồ nước (`line` uốn lượn hoặc `rectangle` xanh `#0284c7`, có các đường gợn sóng phản chiếu ánh sáng).
4. **Điểm nhấn & Nhân vật (Focal Elements)**:
   - Thuyền buồm trôi trên sông, hoa sen nở trên mặt hồ, người đi dạo, xe cộ.
5. **Khung tranh & Tiêu đề (Art Frame & Caption)**:
   - Khung viền đôi bao quanh toàn bộ bức tranh (`type: "frame"` hoặc `rectangle` viền gỗ/than).
   - Tên tác phẩm và chữ ký tác giả (`type: "text"`, font Virgil viết tay ở góc dưới).

### Ví dụ Code Mẫu: Tạo Bức Tranh Phong Cảnh "Núi Phú Sĩ & Hoa Anh Đào" trong 1 Call:
```javascript
const api = window.excalidrawAPI;
api.resetScene(); // Dọn sạch canvas trước khi vẽ

const elements = [
  // 1. Khung tranh & Bầu trời hoàng hôn
  { id: "frame_bg", type: "rectangle", x: 100, y: 80, width: 800, height: 500, backgroundColor: "#fff7ed", fillStyle: "solid", strokeColor: "#334155", strokeWidth: 3, roughness: 1 },
  // 2. Mặt trời đỏ rực rỡ
  { id: "sun", type: "ellipse", x: 420, y: 130, width: 140, height: 140, backgroundColor: "#ef4444", fillStyle: "solid", strokeColor: "#dc2626", strokeWidth: 1, roughness: 0 },
  // 3. Mây bay bồng bềnh
  { id: "cloud1", type: "ellipse", x: 220, y: 160, width: 160, height: 50, backgroundColor: "#ffffff", fillStyle: "solid", strokeColor: "#e2e8f0", roughness: 1, opacity: 90 },
  { id: "cloud2", type: "ellipse", x: 270, y: 140, width: 100, height: 60, backgroundColor: "#ffffff", fillStyle: "solid", strokeColor: "#e2e8f0", roughness: 1, opacity: 90 },
  { id: "cloud3", type: "ellipse", x: 620, y: 180, width: 180, height: 55, backgroundColor: "#ffffff", fillStyle: "solid", strokeColor: "#e2e8f0", roughness: 1, opacity: 90 },
  // 4. Dãy núi Phú Sĩ hùng vĩ (Thân núi xanh tím + Đỉnh tuyết trắng)
  { id: "mountain_body", type: "line", x: 250, y: 380, width: 500, height: 200, points: [[0, 0], [250, -200], [500, 0], [0, 0]], backgroundColor: "#312e81", fillStyle: "hachure", strokeColor: "#1e1b4b", strokeWidth: 2, roughness: 1 },
  { id: "mountain_snow", type: "line", x: 430, y: 236, width: 140, height: 56, points: [[0, 0], [70, -56], [140, 0], [105, 10], [70, 5], [35, 12], [0, 0]], backgroundColor: "#ffffff", fillStyle: "solid", strokeColor: "#cbd5e1", strokeWidth: 1, roughness: 1 },
  // 5. Mặt hồ nước trong xanh phản chiếu
  { id: "lake", type: "rectangle", x: 100, y: 380, width: 800, height: 200, backgroundColor: "#0284c7", fillStyle: "hachure", strokeColor: "#0369a1", strokeWidth: 1, roughness: 1 },
  // 6. Gợn sóng lăn tăn
  { id: "wave1", type: "line", x: 300, y: 420, points: [[0, 0], [40, -4], [80, 0], [120, -4], [160, 0]], strokeColor: "#bae6fd", strokeWidth: 2, roughness: 1 },
  { id: "wave2", type: "line", x: 520, y: 450, points: [[0, 0], [30, -3], [60, 0], [90, -3], [120, 0]], strokeColor: "#bae6fd", strokeWidth: 2, roughness: 1 },
  // 7. Thuyền buồm mộc mạc trôi trên hồ
  { id: "boat_hull", type: "line", x: 600, y: 410, points: [[0, 0], [15, 18], [65, 18], [80, 0], [0, 0]], backgroundColor: "#78350f", fillStyle: "solid", strokeColor: "#451a03", strokeWidth: 2 },
  { id: "boat_sail", type: "line", x: 640, y: 410, points: [[0, 0], [0, -40], [30, -10], [0, 0]], backgroundColor: "#f8fafc", fillStyle: "solid", strokeColor: "#334155", strokeWidth: 1.5 },
  // 8. Cây hoa anh đào tiền cảnh (Thân cây nâu + Tán hoa hồng rực rỡ)
  { id: "tree_trunk", type: "line", x: 160, y: 480, points: [[0, 0], [30, -120], [20, -180], [70, -220], [20, -180], [-20, -230]], strokeColor: "#451a03", strokeWidth: 6, roughness: 1 },
  { id: "sakura_cluster1", type: "ellipse", x: 130, y: 220, width: 90, height: 70, backgroundColor: "#fbcfe8", fillStyle: "solid", strokeColor: "#f472b6", strokeWidth: 1, roughness: 1.5, opacity: 90 },
  { id: "sakura_cluster2", type: "ellipse", x: 190, y: 200, width: 110, height: 80, backgroundColor: "#f472b6", fillStyle: "solid", strokeColor: "#db2777", strokeWidth: 1, roughness: 1.5, opacity: 90 },
  { id: "sakura_cluster3", type: "ellipse", x: 160, y: 270, width: 80, height: 60, backgroundColor: "#fbcfe8", fillStyle: "solid", strokeColor: "#f472b6", strokeWidth: 1, roughness: 1.5, opacity: 90 },
  // 9. Đàn chim bay về tổ
  { id: "bird1", type: "line", x: 380, y: 150, points: [[0, 6], [8, 0], [16, 6]], strokeColor: "#1e293b", strokeWidth: 2, roughness: 0.5 },
  { id: "bird2", type: "line", x: 410, y: 140, points: [[0, 5], [6, 0], [12, 5]], strokeColor: "#1e293b", strokeWidth: 2, roughness: 0.5 },
  // 10. Tiêu đề & Chữ ký tác phẩm
  { id: "title", type: "text", x: 620, y: 535, text: "🌸 Mount Fuji & Sakura", fontSize: 20, fontFamily: 1, strokeColor: "#1e293b" }
];

api.updateScene({ elements, commitToHistory: true });
```

---

## 🛠️ 2. Cách kết nối Live ExcalidrawAPI (React Fiber Walk)

`excalidraw.com` không gắn API trực tiếp trên `window`, nhưng có thể lấy được từ React Fiber bằng `browser_act({ action: "evaluate", expression: "..." })`:

```javascript
function getExcalidrawAPI() {
  if (window.excalidrawAPI) return window.excalidrawAPI;
  const el = document.querySelector('.excalidraw-app') || document.querySelector('.excalidraw') || document.body;
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  let fiber = fiberKey ? el[fiberKey] : null;
  const isAPI = (o) => o && typeof o.updateScene === 'function' && typeof o.getSceneElements === 'function' && typeof o.getAppState === 'function';
  function search(obj, depth) {
    if (depth > 4 || !obj || typeof obj !== 'object') return null;
    if (isAPI(obj)) return obj;
    for (const k in obj) { try { const f = search(obj[k], depth + 1); if (f) return f; } catch (e) {} }
    return null;
  }
  let attempts = 0;
  while (fiber && attempts++ < 25) {
    if (fiber.memoizedProps) { const a = search(fiber.memoizedProps, 0); if (a) return (window.excalidrawAPI = a); }
    let hook = fiber.memoizedState, hookAttempts = 0;
    while (hook && hookAttempts++ < 15) { const a = search(hook.memoizedState, 0); if (a) return (window.excalidrawAPI = a); hook = hook.next; }
    fiber = fiber.return;
  }
  return null;
}
window.excalidrawAPI = window.excalidrawAPI || getExcalidrawAPI();
!!window.excalidrawAPI
```

---

## 📐 3. Quy chuẩn Vẽ Biểu Đồ Kỹ Thuật (Architecture & Flowcharts)

1. **Khoảng cách thoáng đãng (Generous Spacing)**:
   - Giữa các node dọc: tối thiểu **40-60px**.
   - Giữa các cột ngang: tối thiểu **140-220px** để đường mũi tên và nhãn không chồng chéo.
   - Text boxes: padding tối thiểu **20px**.
2. **Quy chuẩn Rẽ Nhánh & Vòng Lặp**:
   - `diamond` luôn có đủ 2 mũi tên `[true]` và `[false]` có gắn nhãn rõ ràng.
   - Vòng lặp phải có nhánh lặp lại (`dashed: true`) và nhánh `[exit]`.
3. **Phối màu theo vai trò (Semantic Color Palette)**:
   - **Start / End**: Xanh dương `#1d4ed8` / Nền `#dbeafe`
   - **Xử lý / Action**: Xanh lá `#166534` / Nền `#dcfce7`
   - **Điều kiện / Gateway**: Hổ phách `#b45309` / Nền `#fef3c7`
   - **Database / Storage**: Cyan `#0e7490` / Nền `#cffafe`
   - **Dịch vụ ngoài / Cloud**: Tím `#6d28d9` / Nền `#ede9fe`
4. **Binding 2 chiều bắt buộc**:
   - Nhãn trong khối: `boundElements: [{ id: textId, type: "text" }]` trên shape và `containerId: shapeId` trên text.
   - Mũi tên kết nối: `startBinding` và `endBinding` trên arrow, kèm `boundElements` trên cả 2 shape đầu/cuối.
