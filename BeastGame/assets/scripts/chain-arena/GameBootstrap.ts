import { _decorator, Camera, Canvas, Component, director, Layers, Node, UITransform, view } from 'cc';
import { ChainArenaController } from './ChainArenaController';

const { ccclass } = _decorator;

/** Attach this one component to any empty node in a new scene. */
@ccclass('GameBootstrap')
export class GameBootstrap extends Component {
  protected onLoad(): void {
    const scene = director.getScene();
    if (!scene || scene.getChildByName('ChainArenaCanvas')) return;

    const canvasNode = new Node('ChainArenaCanvas');
    scene.addChild(canvasNode);
    canvasNode.layer = Layers.Enum.UI_2D;
    const designSize = view.getDesignResolutionSize();
    canvasNode.addComponent(UITransform).setContentSize(designSize);
    canvasNode.setPosition(designSize.width / 2, designSize.height / 2);
    const canvas = canvasNode.addComponent(Canvas);
    const cameraNode = new Node('UICamera');
    cameraNode.setParent(canvasNode);
    cameraNode.layer = Layers.Enum.DEFAULT;
    const camera = cameraNode.addComponent(Camera);
    camera.visibility = Layers.Enum.UI_2D;
    canvas.cameraComponent = camera;
    canvasNode.addComponent(ChainArenaController);
  }
}
