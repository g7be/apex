import { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { game, useGame } from './state/store.ts';
import { cameraState, local } from './state/live.ts';
import { installInput, onKeyPress } from './game/input.ts';
import { MapCamera, cameraTarget, flyTo } from './game/MapCamera.tsx';
import { PlayerMarkers } from './game/PlayerMarkers.tsx';
import { openFloorPlan } from './game/actions.ts';
import { WorldScene } from './world/WorldScene.tsx';
import { loadManifest, streamData } from './world/worldData.ts';
import { loadStateManifest } from './world/stateData.ts';
import { mapStats } from './world/mapLayers.ts';
import { identity, net } from './net/connection.ts';
import { Hud } from './ui/Hud.tsx';
import { PropertyPanel } from './ui/PropertyPanel.tsx';
import { FloorPlanViewer } from './ui/FloorPlanViewer.tsx';
import { LeaseDialog, MyProperties } from './ui/Dialogs.tsx';
import { Chat } from './ui/Chat.tsx';
import { Attribution, Help, JoinScreen, LoadingScreen, Toasts } from './ui/Overlays.tsx';

// Debug hook for devtools and automated smoke tests.
Object.assign(((globalThis as { __indy?: object }).__indy ??= {}), { game, cameraState, cameraTarget, local, mapStats });

function useGlobalKeys() {
  useEffect(() => onKeyPress((code) => {
    const s = game.get();
    if (s.floorPlanFor || s.dialog) return; // modal dialogs handle their own keys
    switch (code) {
      case 'KeyR':
        if (s.selectedId) openFloorPlan(s.selectedId);
        break;
      case 'Home':
        flyTo(0, 0, 420);
        break;
      case 'KeyN':
        cameraTarget.yaw = 0;
        break;
      case 'KeyH':
        game.set({ helpOpen: !s.helpOpen });
        break;
      case 'Escape':
        if (s.helpOpen) game.set({ helpOpen: false });
        else if (s.myPropertiesOpen) game.set({ myPropertiesOpen: false });
        else if (s.selectedId) game.set({ selectedId: null });
        break;
    }
  }), []);
}

export function App() {
  const me = useGame((s) => s.me);
  const manifest = useGame((s) => s.manifest);
  const [joined, setJoined] = useState(identity.hasToken());
  const placed = useRef(false);
  useGlobalKeys();

  useEffect(() => {
    loadManifest()
      .then((m) => {
        // Start centered on Monument Circle (the region origin).
        cameraState.focus = [0, 0, 0];
        cameraTarget.focus = [0, 0, 0];
        void streamData(0, 0);
      })
      .catch((err) => game.set((s) => ({ loading: { ...s.loading, error: String(err.message ?? err) } })));
    void loadStateManifest();
    if (identity.hasToken()) net.connect();
  }, []);

  // Return to where you were last looking.
  useEffect(() => {
    if (!me || !manifest || placed.current) return;
    placed.current = true;
    if (me.lastPosition) {
      const [x, , north] = me.lastPosition;
      flyTo(x, -north);
    }
  }, [me, manifest]);

  return (
    <div className="app">
      <Canvas
        shadows
        dpr={[1, 1.75]}
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}
        camera={{ fov: 45, near: 1, far: 12000, position: [150, 400, 300] }}
        onCreated={({ gl }) => installInput(gl.domElement)}
      >
        <WorldScene />
        <PlayerMarkers />
        <MapCamera />
      </Canvas>
      {joined && me && (
        <>
          <Hud />
          <Chat />
          <PropertyPanel />
          <FloorPlanViewer />
          <LeaseDialog />
          <MyProperties />
          <Help />
        </>
      )}
      <Toasts />
      <Attribution />
      {!joined ? <JoinScreen onJoin={() => setJoined(true)} /> : <LoadingScreen />}
    </div>
  );
}
