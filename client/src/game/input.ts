// Keyboard / mouse input. Gameplay keys are ignored while typing in inputs.
export const keys = new Set<string>();
export const mouse = { dx: 0, dy: 0, wheel: 0, rightDown: false, middleDown: false };

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

type KeyHandler = (code: string, e: KeyboardEvent) => void;
const pressHandlers = new Set<KeyHandler>();
export const onKeyPress = (fn: KeyHandler) => {
  pressHandlers.add(fn);
  return () => { pressHandlers.delete(fn); };
};

let installed = false;
export function installInput(canvas: HTMLElement) {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
    if (!e.repeat) for (const fn of pressHandlers) fn(e.code, e);
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas || mouse.rightDown || mouse.middleDown) {
      mouse.dx += e.movementX;
      mouse.dy += e.movementY;
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) mouse.rightDown = true;
    if (e.button === 1) { mouse.middleDown = true; e.preventDefault(); }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) mouse.rightDown = false;
    if (e.button === 1) mouse.middleDown = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    mouse.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 + 0.5);
    e.preventDefault();
  }, { passive: false });
}

export function consumeMouse() {
  const d = { dx: mouse.dx, dy: mouse.dy, wheel: mouse.wheel };
  mouse.dx = mouse.dy = mouse.wheel = 0;
  return d;
}
