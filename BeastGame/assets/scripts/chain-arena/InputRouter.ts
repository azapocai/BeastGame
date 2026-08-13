import { EventKeyboard, EventMouse, EventTouch, input, Input, KeyCode, view } from 'cc';
import { Math2D, Point2D } from './Math2D';

export interface FrameActions {
  attack: boolean;
  dash: boolean;
  pullTether: boolean;
  restart: boolean;
  toggleDebug: boolean;
}

/** Translates desktop and touch input into the same small game command set. */
export class InputRouter {
  private readonly keys = new Set<KeyCode>();
  private pointer: Point2D = { x: 0, y: 120 };
  private pointerActive = false;
  private joystickId: number | null = null;
  private joystickOrigin: Point2D = { x: 0, y: 0 };
  private joystickPosition: Point2D = { x: 0, y: 0 };
  private attackQueued = false;
  private dashQueued = false;
  private pullTetherQueued = false;
  private restartQueued = false;
  private debugQueued = false;
  private lastMove: Point2D = { x: 0, y: 1 };
  private readonly moveOutput: Point2D = { x: 0, y: 0 };
  private readonly aimOutput: Point2D = { x: 0, y: 1 };
  private readonly actions: FrameActions = {
    attack: false, dash: false, pullTether: false, restart: false, toggleDebug: false,
  };
  private readonly joystickSnapshot = {
    active: false,
    origin: this.joystickOrigin,
    position: this.joystickPosition,
  };

  enable(): void {
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
    input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
    input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
  }

  disable(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
    input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
    input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    this.keys.clear();
  }

  getMove(): Point2D {
    let x = 0;
    let y = 0;
    if (this.hasEither(KeyCode.KEY_A, KeyCode.ARROW_LEFT)) x -= 1;
    if (this.hasEither(KeyCode.KEY_D, KeyCode.ARROW_RIGHT)) x += 1;
    if (this.hasEither(KeyCode.KEY_W, KeyCode.ARROW_UP)) y += 1;
    if (this.hasEither(KeyCode.KEY_S, KeyCode.ARROW_DOWN)) y -= 1;

    if (this.joystickId !== null) {
      x += (this.joystickPosition.x - this.joystickOrigin.x) / 54;
      y += (this.joystickPosition.y - this.joystickOrigin.y) / 54;
    }
    Math2D.normalize(x, y, this.moveOutput);
    if (this.moveOutput.x || this.moveOutput.y) {
      this.lastMove.x = this.moveOutput.x;
      this.lastMove.y = this.moveOutput.y;
    }
    return this.moveOutput;
  }

  getAim(player: Point2D): Point2D {
    if (this.pointerActive) {
      Math2D.normalize(this.pointer.x - player.x, this.pointer.y - player.y, this.aimOutput);
      if (this.aimOutput.x || this.aimOutput.y) return this.aimOutput;
    }
    return this.lastMove;
  }

  consumeActions(): FrameActions {
    this.actions.attack = this.attackQueued;
    this.actions.dash = this.dashQueued;
    this.actions.pullTether = this.pullTetherQueued;
    this.actions.restart = this.restartQueued;
    this.actions.toggleDebug = this.debugQueued;
    this.attackQueued = false;
    this.dashQueued = false;
    this.pullTetherQueued = false;
    this.restartQueued = false;
    this.debugQueued = false;
    return this.actions;
  }

  getJoystick(): { active: boolean; origin: Point2D; position: Point2D } {
    this.joystickSnapshot.active = this.joystickId !== null;
    this.joystickSnapshot.origin = this.joystickOrigin;
    this.joystickSnapshot.position = this.joystickPosition;
    return this.joystickSnapshot;
  }

  private hasEither(first: KeyCode, second: KeyCode): boolean {
    return this.keys.has(first) || this.keys.has(second);
  }

  private onKeyDown(event: EventKeyboard): void {
    this.keys.add(event.keyCode);
    if ([KeyCode.SPACE, KeyCode.KEY_J].indexOf(event.keyCode) !== -1) this.attackQueued = true;
    if ([KeyCode.SHIFT_LEFT, KeyCode.SHIFT_RIGHT, KeyCode.KEY_K].indexOf(event.keyCode) !== -1) this.dashQueued = true;
    if (event.keyCode === KeyCode.KEY_C) this.pullTetherQueued = true;
    if (event.keyCode === KeyCode.KEY_R) this.restartQueued = true;
    if (event.keyCode === KeyCode.F2) this.debugQueued = true;
  }

  private onKeyUp(event: EventKeyboard): void {
    this.keys.delete(event.keyCode);
  }

  private onMouseMove(event: EventMouse): void {
    this.pointer = this.toGamePoint(event.getUILocation().x, event.getUILocation().y);
    this.pointerActive = true;
  }

  private onMouseDown(event: EventMouse): void {
    if (event.getButton() === EventMouse.BUTTON_LEFT) this.attackQueued = true;
  }

  private onTouchStart(event: EventTouch): void {
    const point = this.toGamePoint(event.getUILocation().x, event.getUILocation().y);
    const id = event.getID();
    if (point.x < 0 && this.joystickId === null) {
      this.joystickId = id;
      this.joystickOrigin = point;
      this.joystickPosition = point;
      return;
    }
    // Right side: upper area attacks, lower area triggers dash.
    if (point.y < -140) this.dashQueued = true;
    else this.attackQueued = true;
  }

  private onTouchMove(event: EventTouch): void {
    if (event.getID() === this.joystickId) {
      this.joystickPosition = this.toGamePoint(event.getUILocation().x, event.getUILocation().y);
    }
  }

  private onTouchEnd(event: EventTouch): void {
    if (event.getID() === this.joystickId) this.joystickId = null;
  }

  private toGamePoint(uiX: number, uiY: number): Point2D {
    const visible = view.getVisibleSize();
    return {
      x: (uiX / visible.width - 0.5) * 960,
      y: (uiY / visible.height - 0.5) * 600,
    };
  }
}
