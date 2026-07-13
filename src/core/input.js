// Keyboard + mouse input with pointer-lock camera control.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();      // keys that went down this frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.mouseDown = [false, false, false];
    this.mousePressed = [false, false, false];
    this.pointerLocked = false;
    this.enabled = true;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      if (['Space', 'Tab', 'KeyM', 'Escape'].includes(c)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = [false, false, false]; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.pointerLocked && document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.();
      }
      this.mouseDown[e.button] = true;
      this.mousePressed[e.button] = true;
    });
    window.addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    window.addEventListener('wheel', (e) => { this.wheelDelta += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    // prevent context menu so RMB can aim
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releasePointer() { if (document.pointerLockElement) document.exitPointerLock?.(); }

  down(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  // movement axes relative to key state: forward = +1 when W
  axisV() { return (this.down('KeyW') || this.down('ArrowUp') ? 1 : 0) - (this.down('KeyS') || this.down('ArrowDown') ? 1 : 0); }
  axisH() { return (this.down('KeyD') || this.down('ArrowRight') ? 1 : 0) - (this.down('KeyA') || this.down('ArrowLeft') ? 1 : 0); }

  endFrame() {
    this.pressed.clear();
    this.mousePressed = [false, false, false];
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }
}
