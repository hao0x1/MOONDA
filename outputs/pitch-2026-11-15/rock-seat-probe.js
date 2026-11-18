(async () => {
  const L = window.__moonda.lander, C = window.__moondaCesium, v = window.__viewer;
  const saved = { az: L.az, el: L.el };
  const result = { near: { frames: 0, samples: 0, maxFloatingM: 0, maxAbsoluteErrorM: 0, violations: [], directions: [] }, far: { samples: 0, maxFloatingM: 0, maxAbsoluteErrorM: 0 }, toleranceM: 0.03 };
  const visible = p => {
    if (C.Cartesian3.dot(C.Cartesian3.subtract(p, v.camera.positionWC, new C.Cartesian3()), v.camera.directionWC) <= 0) return false;
    const q = C.SceneTransforms.worldToWindowCoordinates(v.scene, p);
    return q && q.x >= 0 && q.y >= 0 && q.x < v.canvas.clientWidth && q.y < v.canvas.clientHeight;
  };
  let active = null;
  const off = v.scene.postRender.addEventListener(() => {
    if (!active || active.frames >= 6) return;
    active.frames++; result.near.frames++;
    for (const rock of L.rocks) {
      if (!rock.spot || !rock.probe || !rock.model.show || !Number.isFinite(rock.ground) || !visible(rock.base)) continue;
      const found = {tile:null,source:'none'}; const height = L.selectedHeight(rock.probe[0],found);
      if (height === undefined) continue;
      const error = rock.ground - height;
      active.samples++; result.near.samples++;
      if (Math.abs(error)>0.003 && result.near.violations.length<100) result.near.violations.push({errorM:error,frame:active.frames,yaw:active.yaw,id:rock.spot.id,stored:rock.ground,selected:height,cachedLevel:rock.tile?.level??-1,selectedLevel:found.tile?.level??-1,sameTile:rock.tile===found.tile,sameMesh:rock.mesh===found.tile?.data?.renderedMesh,cachedMeshCurrent:rock.mesh===rock.tile?.data?.renderedMesh,resize:rock.resize});
      result.near.maxFloatingM = Math.max(result.near.maxFloatingM, error);
      result.near.maxAbsoluteErrorM = Math.max(result.near.maxAbsoluteErrorM, Math.abs(error));
    }
  });
  try {
    for (let i = 0; i < 4; i++) {
      active = { yaw: (saved.az + i * 90) % 360, frames: 0, samples: 0 };
      result.near.directions.push(active);
      L.az = active.yaw; L.el = -12; L.kick();
      await new Promise(resolve => setTimeout(resolve, 850));
    }
    active = null;
    await window.__pitchMapWait(() => {
      const F = L.farRocks;
      return F?.prim?.ready && F.prim.show && !F.next && F.reseatLeft === 0 && !F.reseatAgain;
    }, 'far-rock natural seating drain', 20000);
    // Read the existing batch and its GPU lift attributes. No seats are changed by this probe.
    const F = L.farRocks, E = F.env, p = F.prim;
    const stride = Math.max(1, Math.floor(F.spotsNow.length / 256));
    for (let i = 0; i < F.spotsNow.length; i += stride) {
      const s = F.spotsNow[i];
      const W = C.Cartesian3.add(E.origin, C.Cartesian3.add(C.Cartesian3.multiplyByScalar(E.east, s.e, new C.Cartesian3()), C.Cartesian3.multiplyByScalar(E.north, s.n, new C.Cartesian3()), new C.Cartesian3()), new C.Cartesian3());
      const c = E.toCartographic(W, new C.Cartographic());
      const selected = L.selectedHeight(c);
      if (selected === undefined) continue;
      const base = E.fromHeight(c, selected, new C.Cartesian3());
      if (!visible(base)) continue;
      const expected = E.height(c), attributes = p.getGeometryInstanceAttributes(i);
      if (expected === undefined || !attributes?.rise) continue;
      const error = F.groundNow[i] + attributes.rise[0] - expected;
      result.far.samples++;
      result.far.maxFloatingM = Math.max(result.far.maxFloatingM, error);
      result.far.maxAbsoluteErrorM = Math.max(result.far.maxAbsoluteErrorM, Math.abs(error));
    }
    window.__pitchRockMetrics = result;
    result.passed = result.near.samples >=20 && result.near.directions.every(d=>d.samples>0) && result.far.samples>=5 && result.near.maxAbsoluteErrorM<=result.toleranceM && result.far.maxAbsoluteErrorM<=result.toleranceM;
    return result;
  } finally {
    off(); L.az = saved.az; L.el = saved.el; L.kick();
  }
})()
