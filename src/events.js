// 事件与快捷键。
//
// 所有点击都通过 data-action 委托处理；键盘快捷键在 window 上统一分发。
// 编辑器在每次重建 DOM 之后需要恢复焦点与光标位置，这一步也在这里做。

const MODIFIER_ONLY = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "Dead"]);

function extensionOf(file) {
  const name = typeof file.name === "string" ? file.name : "";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase();
  }
  const type = typeof file.type === "string" ? file.type : "";
  const slash = type.indexOf("/");
  return slash >= 0 ? type.slice(slash + 1).toLowerCase() : "";
}

function acceleratorFrom(event) {
  if (MODIFIER_ONLY.has(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");

  const code = event.code && event.code.length > 0 ? event.code : event.key;
  parts.push(code);
  return parts.join("+");
}

export function createInteraction({ host, store, invoke }) {
  let editorMemory = { key: null, value: null, start: null, end: null };
  let scrollTops = [];

  // 状态一变就重建整棵 DOM，滚动位置得手动延续。
  const SCROLLABLE = ".groups, .tasks, .sections, .settings__body";

  function captureScroll() {
    scrollTops = Array.from(host.querySelectorAll(SCROLLABLE)).map(
      (node) => node.scrollTop
    );
  }

  function restoreScroll() {
    const apply = () => {
      const nodes = Array.from(host.querySelectorAll(SCROLLABLE));
      nodes.forEach((node, index) => {
        if (index < scrollTops.length) {
          node.scrollTop = scrollTops[index];
        }
      });
    };
    apply();
    // 重建之后布局可能在同一帧里继续变化，下一帧再对齐一次。
    requestAnimationFrame(apply);
  }

  // 入场效果只属于「刚刚打开」那一次：渲染完就清掉标记，并在下一帧移除
  // 初始状态类，让 transition 跑完。之后任何重建都不会再触发入场。
  function clearEntering() {
    const ui = store.getUi();

    if (ui.settingsFresh) {
      ui.settingsFresh = false;
      const panel = host.querySelector(".settings__panel.is-entering");
      if (panel) {
        requestAnimationFrame(() => panel.classList.remove("is-entering"));
      }
    }

    if (ui.toasts.some((toast) => toast.fresh)) {
      ui.toasts.forEach((toast) => {
        toast.fresh = false;
      });
      const entering = host.querySelectorAll(".toast.is-entering");
      if (entering.length > 0) {
        requestAnimationFrame(() => {
          entering.forEach((node) => node.classList.remove("is-entering"));
        });
      }
    }
  }

  function taskIdNearPosition(x, y) {
    const ratio = window.devicePixelRatio || 1;
    const element = document.elementFromPoint(x / ratio, y / ratio);
    const row = element ? element.closest("[data-id]") : null;
    if (row && row.dataset.id && row.classList.contains("task")) {
      return row.dataset.id;
    }
    return store.getUi().cursorTaskId;
  }

  async function importPaths(taskId, paths) {
    const imported = [];
    for (const path of paths) {
      try {
        const result = await invoke("import_image", { source: path });
        imported.push(result.relPath);
      } catch (error) {
        store.toast(String(error), "error");
      }
    }
    if (imported.length > 0) {
      store.addImages(taskId, imported);
      store.toast(`已添加 ${imported.length} 张图片。`);
    }
  }

  async function importFiles(taskId, files) {
    const imported = [];
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const result = await invoke("import_image_bytes", {
          bytes: Array.from(new Uint8Array(buffer)),
          ext: extensionOf(file),
        });
        imported.push(result.relPath);
      } catch (error) {
        store.toast(String(error), "error");
      }
    }
    if (imported.length > 0) {
      store.addImages(taskId, imported);
      store.toast(`已添加 ${imported.length} 张图片。`);
    }
  }

  async function pickImageFor(taskId) {
    try {
      const picked = await invoke("pick_image");
      if (picked) await importPaths(taskId, [picked]);
    } catch (error) {
      store.toast(String(error), "error");
    }
  }

  /**
   * 用户点到编辑器以外的位置，就等于结束这次编辑。
   *
   * 放在 click 里同步做，而不是只靠 focusout：提交会重建 DOM，等焦点事件
   * 绕一圈回来时，这次点击的目标节点早就不在文档里了，动作会被丢掉。
   * target 是本次点击命中的 [data-action] 元素。
   */
  function flushEditing(target) {
    const ui = store.getUi();

    if (ui.editingTaskId) {
      const editor = host.querySelector(".task__editor");
      if (editor && !editor.contains(target)) {
        store.commitEdit(editor.dataset.id, editor.value);
      }
    }

    if (ui.editingGroupId) {
      const input = host.querySelector(".group__editor");
      if (input && !input.contains(target)) {
        store.renameGroup(input.dataset.id, input.value);
      }
    }
  }

  function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target || !host.contains(target)) return;

    flushEditing(target);

    const { action } = target.dataset;
    const id = target.dataset.id;

    switch (action) {
      case "settings-panel":
      case "editor":
      case "group-editor":
        return;

      case "settings-backdrop":
        if (event.target === target) store.patchUi({ settingsOpen: false });
        return;

      case "open-settings":
        store.patchUi({ settingsOpen: true, settingsFresh: true, recordingHotkey: false });
        return;

      case "close-settings":
        store.patchUi({ settingsOpen: false, recordingHotkey: false });
        return;

      case "select-group":
        store.selectGroup(id);
        return;

      case "add-group":
        store.addGroup("新分组");
        return;

      case "rename-group":
        store.startRenameGroup(id);
        return;

      case "move-group":
        store.moveGroup(id, Number(target.dataset.delta));
        return;

      case "delete-group":
        store.deleteGroup(id);
        return;

      case "toggle-collapse":
        store.toggleCollapse(id);
        return;

      case "add-task":
        store.addTask("");
        return;

      case "focus-task":
        store.setCursor(id);
        return;

      case "toggle-task":
        store.toggleTask(id);
        return;

      case "edit-task":
        store.startEdit(id);
        return;

      case "delete-task":
        store.removeTask(id);
        return;

      case "add-image":
        void pickImageFor(id);
        return;

      case "remove-image":
        store.removeImage(id, target.dataset.rel);
        return;

      case "preview-image":
        store.patchUi({ previewImage: target.dataset.rel });
        return;

      case "close-preview":
        store.patchUi({ previewImage: null });
        return;

      case "update-setting":
        store.updateSetting(target.dataset.key, target.dataset.value);
        return;

      case "update-setting-bool": {
        const key = target.dataset.key;
        store.updateSetting(key, !store.getData().settings[key]);
        return;
      }

      case "toggle-autostart":
        void store.toggleAutoStart();
        return;

      case "record-hotkey":
        store.beginHotkeyRecording();
        return;

      case "change-data-dir":
        void store.changeDataDir();
        return;

      case "open-data-dir":
        store.openDataDir();
        return;

      case "quit-app":
        store.quitApp();
        return;

      default:
        return;
    }
  }

  function handleDoubleClick(event) {
    const row = event.target.closest(".task");
    if (row && host.contains(row)) {
      if (row.classList.contains("is-editing")) return;
      const id = row.dataset.id;
      if (id) store.startEdit(id);
      return;
    }

    // 双击分组名等同于点「重命名分组」。
    const groupRow = event.target.closest(".group");
    if (groupRow && host.contains(groupRow)) {
      const id = groupRow.dataset.id;
      if (id) store.startRenameGroup(id);
    }
  }

  function handleKeyDown(event) {
    const ui = store.getUi();

    if (ui.recordingHotkey) {
      event.preventDefault();
      if (event.key === "Escape") {
        store.cancelHotkeyRecording();
        return;
      }
      const accelerator = acceleratorFrom(event);
      if (accelerator === null) return;
      void store.applyRecordedHotkey(accelerator);
      return;
    }

    const active = document.activeElement;
    const inEditor =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;

    if (inEditor) {
      const action = active.dataset ? active.dataset.action : null;
      if (action === "editor") {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          store.commitEdit(active.dataset.id, active.value);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          store.cancelEdit();
          return;
        }
      }
      if (action === "group-editor") {
        if (event.key === "Enter") {
          event.preventDefault();
          store.renameGroup(active.dataset.id, active.value);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          const group = store.getData().groups.find((item) => item.id === active.dataset.id);
          store.renameGroup(active.dataset.id, group ? group.name : "");
          return;
        }
      }
      return;
    }

    if (ui.settingsOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        store.patchUi({ settingsOpen: false, recordingHotkey: false });
      }
      return;
    }

    if (ui.previewImage) {
      if (event.key === "Escape") {
        event.preventDefault();
        store.patchUi({ previewImage: null });
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      store.addTask("");
      return;
    }

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        store.cycleTask(-1);
        return;
      case "ArrowDown":
        event.preventDefault();
        store.cycleTask(1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        store.cycleGroup(-1);
        return;
      case "ArrowRight":
        event.preventDefault();
        store.cycleGroup(1);
        return;
      case " ":
        event.preventDefault();
        if (ui.cursorTaskId) store.toggleTask(ui.cursorTaskId);
        return;
      case "Enter":
        event.preventDefault();
        if (ui.cursorTaskId) store.startEdit(ui.cursorTaskId);
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        if (ui.cursorTaskId) store.removeTask(ui.cursorTaskId);
        return;
      case "Escape":
        event.preventDefault();
        store.patchUi({ editingTaskId: null });
        return;
      default:
        return;
    }
  }

  function handlePaste(event) {
    const ui = store.getUi();
    const taskId = ui.editingTaskId ?? ui.cursorTaskId;
    if (!taskId) return;

    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      String(file.type).startsWith("image/")
    );
    if (files.length === 0) return;

    event.preventDefault();
    void importFiles(taskId, files);
  }

  /**
   * 输入框失焦就保存：点别处、切到别的程序都算。
   *
   * 延后一个宏任务再提交，是为了让触发失焦的那次点击先落到它自己的目标上。
   * 提交会重建整棵 DOM，如果同步处理，mousedown 之后元素就被换掉了，
   * mouseup 落在新元素上，这次 click 就永远不会触发。
   */
  function handleFocusOut(event) {
    const target = event.target;

    // 元素已经被重建换掉时，浏览器同样会派发一次焦点丢失事件。那不是用户
    // 离开，只是渲染方式留下的痕迹；提交它会把刚点开的分组名输入框关掉。
    if (!target.isConnected) return;

    if (target instanceof HTMLTextAreaElement && target.dataset.action === "editor") {
      const id = target.dataset.id;
      const value = target.value;
      setTimeout(() => {
        if (store.getUi().editingTaskId !== id) return;
        store.commitEdit(id, value);
      }, 0);
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.action === "group-editor") {
      const id = target.dataset.id;
      const value = target.value;
      setTimeout(() => {
        if (store.getUi().editingGroupId !== id) return;
        store.renameGroup(id, value);
      }, 0);
    }
  }

  function registerTauriDragDrop() {
    const api = window.__TAURI__;
    if (!api?.event?.listen) return;

    api.event.listen("tauri://drag-drop", async (event) => {
      const payload = event.payload ?? {};
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      if (paths.length === 0) return;

      const position = payload.position;
      const taskId =
        position && Number.isFinite(position.x) && Number.isFinite(position.y)
          ? taskIdNearPosition(position.x, position.y)
          : store.getUi().cursorTaskId;

      if (!taskId) {
        store.toast("先把鼠标移到某条待办上，再拖入图片。", "warn");
        return;
      }
      await importPaths(taskId, paths);
    });
  }

  function captureEditor() {
    const editor = host.querySelector(".task__editor");
    if (editor) {
      editorMemory = {
        key: `task:${editor.dataset.id}`,
        value: editor.value,
        start: editor.selectionStart,
        end: editor.selectionEnd,
      };
      return;
    }
    const groupEditor = host.querySelector(".group__editor");
    if (groupEditor) {
      editorMemory = {
        key: `group:${groupEditor.dataset.id}`,
        value: groupEditor.value,
        start: groupEditor.selectionStart,
        end: groupEditor.selectionEnd,
      };
    }
  }

  function restoreEditor() {
    const editor = host.querySelector(".task__editor");
    const groupEditor = host.querySelector(".group__editor");
    const node = editor ?? groupEditor;
    if (!node) {
      editorMemory = { key: null, value: null, start: null, end: null };
      return;
    }

    const key = `${editor ? "task" : "group"}:${node.dataset.id}`;
    if (editorMemory.key !== key) {
      editorMemory = {
        key,
        value: editor ? "" : node.value,
        start: null,
        end: null,
      };
      if (editor) {
        const task = store.getData().tasks.find((item) => item.id === node.dataset.id);
        editorMemory.value = task ? task.text : "";
      }
    }

    node.value = editorMemory.value ?? "";
    node.focus({ preventScroll: true });

    const end = editorMemory.end;
    if (Number.isFinite(end)) {
      node.setSelectionRange(editorMemory.start ?? end, end);
    } else {
      node.setSelectionRange(node.value.length, node.value.length);
    }
  }

  host.addEventListener("click", handleClick);
  host.addEventListener("dblclick", handleDoubleClick);
  host.addEventListener("paste", handlePaste);
  host.addEventListener("focusout", handleFocusOut);
  window.addEventListener("keydown", handleKeyDown);
  registerTauriDragDrop();

  function beforeRender() {
    captureEditor();
    captureScroll();
  }

  function afterRender() {
    restoreEditor();
    restoreScroll();
    clearEntering();
  }

  return { beforeRender, afterRender };
}
