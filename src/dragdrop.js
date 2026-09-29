// 拖拽层：用 Pointer Events 手写，不用 HTML5 拖放。
//
// 原因见 docs/superpowers/specs/2026-09-29-drag-drop-design.md：Windows 上
// Tauri 的 dragDropEnabled（默认开启）会挡住 HTML5 拖拽，而那个开关正是
// 「拖文件进窗口导入图片」赖以工作的东西，两者只能选一个。这里保住图片拖放。
//
// 这一层只管手势、落点与视觉反馈，数据改动交给 store.dropTask。

/** 位移超过这么多才算拖拽，用来把单击、双击与拖动分开。 */
const DRAG_THRESHOLD_PX = 5;

/** 指针进入工作区上下这个范围内就开始自动滚动。 */
const AUTO_SCROLL_EDGE_PX = 36;

/** 自动滚动每帧最多走多少像素。 */
const AUTO_SCROLL_MAX_STEP = 20;

/** 按在这几个地方时不启动拖拽，它们各有自己的点击行为。 */
const NO_DRAG_SELECTOR = ".task__check, .task__tools, .task__editor, .due-editor";

/** 拖拽刚结束时吞掉的那一次 click，避免顺带把这一行带进编辑态。 */
const CLICK_SUPPRESS_MS = 300;

export function createDragLayer({ host, store, enabled = () => true }) {
  let pointerId = null;
  let pressedRow = null;
  let taskId = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  let dragging = false;
  let ghost = null;
  let ghostOffsetX = 0;
  let ghostOffsetY = 0;
  let placeholder = null;
  let dropTarget = null;
  let litButton = null;

  let scrollFrame = null;
  let scrollContainer = null;
  let scrollStep = 0;

  let suppressClickUntil = 0;

  // ---- 收尾 -----------------------------------------------------------

  function clearVisuals() {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    if (placeholder) {
      placeholder.remove();
      placeholder = null;
    }
    if (litButton) {
      litButton.classList.remove("is-drop-target");
      litButton = null;
    }
    if (pressedRow) pressedRow.classList.remove("is-dragging");

    document.body.classList.remove("is-dragging");
    stopAutoScroll();
  }

  function reset() {
    clearVisuals();
    pointerId = null;
    pressedRow = null;
    taskId = null;
    dragging = false;
    dropTarget = null;
  }

  /** 中途作废：Esc、pointercancel、重渲染之后都走这里。 */
  function cancel() {
    if (pointerId === null && !dragging) return;
    reset();
  }

  // ---- 手势 -----------------------------------------------------------

  function onPointerDown(event) {
    // 只认左键与第一个按下的指针，多点触控时后来的直接忽略。
    if (event.button !== 0) return;
    if (pointerId !== null) return;
    if (!enabled()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const row = target.closest("li.task");
    if (!row || !host.contains(row)) return;
    if (row.classList.contains("is-editing")) return;
    if (target.closest(NO_DRAG_SELECTOR)) return;
    if (!row.dataset.id) return;

    pointerId = event.pointerId;
    pressedRow = row;
    taskId = row.dataset.id;
    startX = event.clientX;
    startY = event.clientY;
    lastX = startX;
    lastY = startY;
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;

    lastX = event.clientX;
    lastY = event.clientY;

    if (!dragging) {
      const moved = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (moved < DRAG_THRESHOLD_PX) return;
      if (!beginDrag(event)) return;
    }

    event.preventDefault();
    positionGhost(lastX, lastY);
    trackDropTarget(lastX, lastY);
    trackAutoScroll(lastY);
  }

  function beginDrag(event) {
    // 按下之后到越过阈值之间，节点可能已经被一次重渲染换掉了。
    if (!pressedRow || !host.contains(pressedRow)) {
      reset();
      return false;
    }

    dragging = true;

    // 捕获指针：手滑到窗口外面再松开，也还能收到 pointerup。
    try {
      pressedRow.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败不影响窗口级的监听，忽略。
    }

    pressedRow.classList.add("is-dragging");
    document.body.classList.add("is-dragging");
    // 按下之后浏览器可能已经开始选文本，这里抹掉这次选择。
    window.getSelection()?.removeAllRanges();

    buildGhost(pressedRow);
    return true;
  }

  function buildGhost(row) {
    const rect = row.getBoundingClientRect();
    const node = row.cloneNode(true);

    node.classList.add("drag-ghost");
    node.classList.remove("is-dragging");
    node.removeAttribute("data-action");
    node.style.width = `${rect.width}px`;

    document.body.append(node);
    ghost = node;

    ghostOffsetX = startX - rect.left;
    ghostOffsetY = startY - rect.top;
    positionGhost(startX, startY);
  }

  function positionGhost(x, y) {
    if (!ghost) return;
    ghost.style.transform = `translate3d(${x - ghostOffsetX}px, ${y - ghostOffsetY}px, 0)`;
  }

  function onPointerUp(event) {
    if (event.pointerId !== pointerId) return;

    if (!dragging) {
      reset();
      return;
    }

    const drop = resolveDrop();
    const moved = taskId;

    reset();
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;

    if (drop && moved) store.dropTask(moved, drop);
  }

  function onPointerCancel(event) {
    if (event.pointerId !== pointerId) return;
    cancel();
  }

  /** 拖拽那一下也会补一个 click，别让它顺手把这一行带进编辑态。 */
  function onClickCapture(event) {
    if (performance.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    event.stopPropagation();
    event.preventDefault();
  }

  // ---- 落点 -----------------------------------------------------------

  function resolveTarget(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof Element)) return null;

    // 左栏的分组按钮：落到那个分组的末尾。侧栏里插不进占位条，这一类落点
    // 靠按钮自己的高亮表示。
    const button = element.closest("button.group");
    if (button && host.contains(button) && button.dataset.id) {
      return { kind: "group", groupId: button.dataset.id, button };
    }

    const row = element.closest("li.task");
    if (row && host.contains(row)) {
      const list = row.closest("ul.tasks");
      if (list) {
        const rect = row.getBoundingClientRect();
        return { kind: "row", row, list, after: y > rect.top + rect.height / 2 };
      }
    }

    const list = element.closest("ul.tasks");
    if (list && host.contains(list)) {
      return { kind: "list", list };
    }

    const section = element.closest("section.section");
    if (section && host.contains(section) && !section.classList.contains("is-collapsed")) {
      const inner = section.querySelector("ul.tasks");
      if (inner) return { kind: "list", list: inner };

      const groupId = section.dataset.id;
      if (groupId) return { kind: "empty-group", groupId, list: section };
    }

    return null;
  }

  function trackDropTarget(x, y) {
    const target = resolveTarget(x, y);
    dropTarget = target;

    const wanted = target && target.kind === "group" ? target.button : null;
    if (litButton !== wanted) {
      litButton?.classList.remove("is-drop-target");
      litButton = wanted;
      litButton?.classList.add("is-drop-target");
    }

    if (!target || target.kind === "group") {
      placeholder?.remove();
      return;
    }

    placePlaceholder(target);
  }

  function placePlaceholder(target) {
    if (!placeholder) {
      placeholder = document.createElement("li");
      placeholder.className = "drop-marker";
      placeholder.setAttribute("aria-hidden", "true");
    }

    if (target.kind === "row") {
      const reference = target.after ? target.row.nextSibling : target.row;
      // insertBefore 顺手会把占位条从原位置挪过来。
      if (placeholder.parentNode !== target.list || placeholder.nextSibling !== reference) {
        target.list.insertBefore(placeholder, reference);
      }
      return;
    }

    if (placeholder.parentNode !== target.list || placeholder.nextSibling !== null) {
      target.list.append(placeholder);
    }
  }

  /** 占位条所在列表属于哪个分组。 */
  function groupIdOf(list) {
    const section = list.closest("section[data-id]");
    if (section) return section.dataset.id;
    // 面板布局里只有一个 ul.tasks，那就是当前分组。
    return store.getUi().activeGroupId;
  }

  function resolveDrop() {
    const target = dropTarget;
    if (!target) return null;

    if (target.kind === "group") {
      return { groupId: target.groupId, beforeTaskId: null };
    }

    if (target.kind === "empty-group") {
      return { groupId: target.groupId, beforeTaskId: null };
    }

    const groupId = groupIdOf(target.list);
    if (!groupId) return null;

    // 占位条后面那条任务就是插入点；后面没有任务就是落到末尾。
    const next = placeholder?.nextElementSibling ?? null;
    const beforeTaskId = next && next.classList.contains("task") ? next.dataset.id : null;

    return { groupId, beforeTaskId };
  }

  // ---- 边缘自动滚动 ---------------------------------------------------

  function trackAutoScroll(clientY) {
    if (!scrollContainer || !host.contains(scrollContainer)) {
      scrollContainer = host.querySelector(".workspace");
    }
    if (!scrollContainer) return;

    const rect = scrollContainer.getBoundingClientRect();
    const top = rect.top + AUTO_SCROLL_EDGE_PX;
    const bottom = rect.bottom - AUTO_SCROLL_EDGE_PX;

    let step = 0;
    if (clientY < top) {
      step = -AUTO_SCROLL_MAX_STEP * ((top - clientY) / AUTO_SCROLL_EDGE_PX);
    } else if (clientY > bottom) {
      step = AUTO_SCROLL_MAX_STEP * ((clientY - bottom) / AUTO_SCROLL_EDGE_PX);
    }

    scrollStep = Math.max(-AUTO_SCROLL_MAX_STEP, Math.min(AUTO_SCROLL_MAX_STEP, step));
    if (scrollStep === 0) stopAutoScroll();
    else startAutoScroll();
  }

  function startAutoScroll() {
    if (scrollFrame !== null) return;
    scrollFrame = window.requestAnimationFrame(tickAutoScroll);
  }

  function tickAutoScroll() {
    scrollFrame = null;
    if (!dragging || scrollStep === 0 || !scrollContainer) return;

    scrollContainer.scrollTop += scrollStep;
    // 滚动之后行都挪了位，落点得按指针当前的位置重算一遍。
    trackDropTarget(lastX, lastY);

    scrollFrame = window.requestAnimationFrame(tickAutoScroll);
  }

  function stopAutoScroll() {
    scrollStep = 0;
    if (scrollFrame !== null) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
  }

  // ---- 装配 -----------------------------------------------------------

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("click", onClickCapture, true);
  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);

  return { cancel, isDragging: () => dragging };
}
