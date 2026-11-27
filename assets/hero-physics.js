(() => {
  "use strict";

  const heading = document.querySelector(".hero h1");
  const hero = document.querySelector(".hero");
  const loader = document.getElementById("page-transition");
  if (!heading || !hero || heading.dataset.physicsFallReady) return;

  const sourceText = Array.from(heading.childNodes).find(node =>
    node.nodeType === Node.TEXT_NODE && node.textContent.trim()
  );
  if (!sourceText) return;

  const word = document.createElement("span");
  word.className = "hero-word";
  word.setAttribute("aria-hidden", "true");

  const glyphs = Array.from(sourceText.textContent.trim()).map(character => {
    const unit = document.createElement("span");
    unit.className = "fall-unit";

    const body = document.createElement("span");
    body.className = "fall-object";

    const face = document.createElement("span");
    face.className = "fall-letter";
    face.textContent = character;

    body.appendChild(face);
    unit.appendChild(body);
    word.appendChild(unit);
    return { body, face, character };
  });

  sourceText.replaceWith(word);
  heading.setAttribute("aria-label", "KAELITH 69");
  heading.dataset.physicsFallReady = "true";

  /*
   * Scene model:
   *   X = across the word
   *   Y = depth, positive away from the viewer
   *   Z = height above the floor
   *
   * Each glyph is a thin rigid slab. Motion is constrained to Y/Z translation
   * and rotation about X so the typography keeps its horizontal layout while
   * still being able to tip forward onto the floor.
   *
   * The camera is orthographic and pitched down by CAMERA_PITCH. The same
   * projection is used for glyph transforms and floor shadow coordinates.
   */
  const PPM = 100;
  const GRAVITY = 9.81;
  const FIXED_DT = 1 / 120;
  const MAX_FRAME_DT = 0.12;
  const MAX_STEPS_PER_FRAME = 16;
  const CAMERA_PITCH = 18 * Math.PI / 180;
  const SIN_PITCH = Math.sin(CAMERA_PITCH);
  const COS_PITCH = Math.cos(CAMERA_PITCH);
  const THICKNESS = 0.035;
  const DENSITY = 650;
  const RESTITUTION = 0.12;
  const FRICTION = 0.62;
  const SHADOW_STRENGTH = 0.66;
  const LIGHT_Y = 6.0;
  const LIGHT_Z = 32.0;
  const LIGHT_WIDTH = 1.8;
  const LIGHT_HEIGHT = 1.0;
  const FILL_LIGHT_Y = -5.0;
  const FILL_LIGHT_Z = 4.0;
  const FILL_LIGHT_POWER = 11.5;
  const AMBIENT_BRIGHTNESS = 0.72;
  const SAMPLE_COLUMNS = 4;
  const SAMPLE_ROWS = 2;
  const SAMPLE_COUNT = SAMPLE_COLUMNS * SAMPLE_ROWS;
  const LIGHT_SAMPLES = [];
  const SOURCE_QUAD = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 }
  ];
  const DEST_QUAD = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 }
  ];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;

  const staticCanvas = document.createElement("canvas");
  staticCanvas.className = "hero-physics-shadow";
  staticCanvas.setAttribute("aria-hidden", "true");

  const dynamicCanvas = document.createElement("canvas");
  dynamicCanvas.className = "hero-physics-shadow hero-physics-shadow--dynamic";
  dynamicCanvas.setAttribute("aria-hidden", "true");

  hero.insertBefore(staticCanvas, hero.firstChild);
  hero.insertBefore(dynamicCanvas, staticCanvas.nextSibling);

  const scratchCanvas = document.createElement("canvas");
  const staticCtx = staticCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const dynamicCtx = dynamicCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const scratchCtx = scratchCanvas.getContext("2d", { alpha: true, willReadFrequently: true });

  if (!staticCtx || !dynamicCtx || !scratchCtx) {
    staticCanvas.remove();
    dynamicCanvas.remove();
    return;
  }

  let sceneWidth = 0;
  let sceneHeight = 0;
  let dpr = 1;
  let lightCenterX = 0;
  let lastTime = 0;
  let accumulator = 0;
  let animationId = 0;
  let started = false;
  let startRequested = false;
  let disposed = false;

  const makeMask = (state) => {
    const mask = document.createElement("canvas");
    mask.width = Math.max(1, Math.ceil(state.width * dpr));
    mask.height = Math.max(1, Math.ceil(state.height * dpr));

    const maskCtx = mask.getContext("2d", { willReadFrequently: true });
    if (!maskCtx) return null;

    const style = getComputedStyle(state.face);
    maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    maskCtx.fillStyle = "#080808";
    maskCtx.font = style.font;
    maskCtx.textAlign = "center";
    maskCtx.textBaseline = "alphabetic";
    if ("letterSpacing" in maskCtx) maskCtx.letterSpacing = style.letterSpacing;

    const metrics = maskCtx.measureText(state.character);
    const fontSize = parseFloat(style.fontSize) || state.height;
    const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.78;
    const descent = metrics.actualBoundingBoxDescent || fontSize * 0.12;
    const baseline = (state.height - ascent - descent) / 2 + ascent;
    maskCtx.fillText(state.character, state.width / 2, baseline, state.width);

    const pixels = maskCtx.getImageData(0, 0, mask.width, mask.height).data;
    let minY = mask.height;
    let maxY = -1;

    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (pixels[(y * mask.width + x) * 4 + 3] < 32) continue;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxY < 0) {
      state.minLocalZ = -state.height / (2 * PPM);
      state.maxLocalZ = state.height / (2 * PPM);
    } else {
      state.minLocalZ = (state.height / 2 - maxY / dpr) / PPM;
      state.maxLocalZ = (state.height / 2 - minY / dpr) / PPM;
    }

    state.mask = mask;
    state.maskDpr = dpr;
    return mask;
  };

  const updateMassProperties = state => {
    state.widthM = state.width / PPM;
    state.heightM = state.height / PPM;
    state.mass = Math.max(
      0.01,
      state.widthM * state.heightM * THICKNESS * DENSITY
    );
    state.inertia = Math.max(
      0.0001,
      state.mass * (state.heightM * state.heightM + THICKNESS * THICKNESS) / 12
    );
  };

  const measureGlyph = state => {
    const previousTransform = state.body.style.transform;
    state.body.style.transform = "none";
    const rect = state.face.getBoundingClientRect();
    state.body.style.transform = previousTransform;

    state.width = Math.max(1, rect.width);
    state.height = Math.max(1, rect.height);
    state.anchorX = rect.left - hero.getBoundingClientRect().left + state.width / 2;
    state.baselineY = rect.bottom - hero.getBoundingClientRect().top;
    return rect;
  };

  const states = glyphs.map((glyph, index) => {
    const state = {
      body: glyph.body,
      face: glyph.face,
      character: glyph.character,
      width: 1,
      height: 1,
      widthM: 0,
      heightM: 0,
      anchorX: 0,
      baselineY: 0,
      initialX: 0,
      x: 0,
      y: 0,
      z: 0,
      vy: 0,
      vz: 0,
      angle: 0,
      omega: 0,
      previousY: 0,
      previousZ: 0,
      previousAngle: 0,
      renderY: 0,
      renderZ: 0,
      renderAngle: 0,
      delay: index * 0.055,
      settled: false,
      pendingBake: false,
      mass: 1,
      inertia: 1,
      minLocalZ: 0,
      maxLocalZ: 0,
      mask: null,
      maskDpr: 1
    };

    state.body.style.transformOrigin = "0 0";
    state.body.style.willChange = "auto";
    measureGlyph(state);
    state.initialX = state.anchorX / PPM;
    state.x = state.initialX;
    updateMassProperties(state);
    makeMask(state);

    const sign = index % 2 === 0 ? 1 : -1;
    const initialFallHeight = clamp(hero.clientHeight * 0.64, 380, 620) / PPM;
    state.z = initialFallHeight + state.heightM / 2;
    state.angle = sign * (0.012 + (index % 3) * 0.004);
    state.omega = sign * (0.055 + (index % 4) * 0.012);

    state.previousY = state.y;
    state.previousZ = state.z;
    state.previousAngle = state.angle;
    state.renderY = state.y;
    state.renderZ = state.z;
    state.renderAngle = state.angle;

    return state;
  });

  lightCenterX = states.reduce((sum, state) => sum + state.initialX, 0) / states.length;

  for (let row = 0; row < SAMPLE_ROWS; row++) {
    for (let column = 0; column < SAMPLE_COLUMNS; column++) {
      LIGHT_SAMPLES.push({
        x: 0,
        y: LIGHT_Y,
        z: LIGHT_Z,
        offsetX: ((column + 0.5) / SAMPLE_COLUMNS - 0.5) * LIGHT_WIDTH,
        offsetZ: ((row + 0.5) / SAMPLE_ROWS - 0.5) * LIGHT_HEIGHT
      });
    }
  }

  const updateLightSamples = () => {
    lightCenterX = states.reduce((sum, state) => sum + state.initialX, 0) / states.length;
    for (const sample of LIGHT_SAMPLES) {
      sample.x = lightCenterX + sample.offsetX;
      sample.z = LIGHT_Z + sample.offsetZ;
    }
  };

  const setCanvasSize = () => {
    const rect = hero.getBoundingClientRect();
    sceneWidth = Math.max(1, rect.width);
    sceneHeight = Math.max(1, rect.height);

    const pixelBudget = 2800000;
    const budgetDpr = Math.sqrt(pixelBudget / (sceneWidth * sceneHeight));
    dpr = Math.max(1, Math.min(1.75, window.devicePixelRatio || 1, budgetDpr));

    const pixelWidth = Math.max(1, Math.round(sceneWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(sceneHeight * dpr));

    for (const canvas of [staticCanvas, dynamicCanvas, scratchCanvas]) {
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      canvas.style.width = sceneWidth + "px";
      canvas.style.height = sceneHeight + "px";
    }

    staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dynamicCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scratchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const applyBody = state => {
    const theta = state.renderAngle;
    const projectedScaleY = Math.cos(CAMERA_PITCH + theta);
    const frontOffset = (THICKNESS / 2) * PPM * Math.sin(CAMERA_PITCH + theta);
    const cameraDepth = PPM * (SIN_PITCH * state.renderY + COS_PITCH * state.renderZ);
    const translateY = state.height - cameraDepth + frontOffset - projectedScaleY * state.height / 2;

    state.body.style.transform =
      "matrix(1,0,0," + projectedScaleY.toFixed(6) + ",0," + translateY.toFixed(3) + ")";

    // A camera-side fill light uses Lambert's cosine law and inverse-square
    // attenuation. The rear area key remains responsible for the floor shadow.
    const lightDY = FILL_LIGHT_Y - state.renderY;
    const lightDZ = FILL_LIGHT_Z - state.renderZ;
    const fillDistanceSquared = lightDY * lightDY + lightDZ * lightDZ;
    const fillDistance = Math.sqrt(Math.max(0.0001, fillDistanceSquared));
    const lambert = Math.max(
      0,
      (-Math.cos(theta) * lightDY - Math.sin(theta) * lightDZ) / fillDistance
    );
    const directFill = Math.min(
      1 - AMBIENT_BRIGHTNESS,
      FILL_LIGHT_POWER / Math.max(1, fillDistanceSquared) * lambert
    );
    const faceFacingCamera = Math.cos(CAMERA_PITCH + theta);
    const faceOpacity = clamp((faceFacingCamera + 0.035) / 0.18, 0, 1);
    const brightness = AMBIENT_BRIGHTNESS + directFill;

    state.face.style.opacity = faceOpacity.toFixed(3);
    state.face.style.filter = "brightness(" + brightness.toFixed(3) + ")";
  };

  const projectPointToFloor = (state, x, y, source, output) => {
    const localX = (x - state.width / 2) / PPM;
    const localZ = (state.height / 2 - y) / PPM;
    const sinAngle = Math.sin(state.renderAngle);
    const cosAngle = Math.cos(state.renderAngle);

    const worldX = state.x + localX;
    const worldY = state.renderY - sinAngle * localZ;
    const worldZ = state.renderZ + cosAngle * localZ;
    const denominator = source.z - worldZ;

    if (denominator <= 0.001) return false;

    const rayT = source.z / denominator;
    const floorX = source.x + rayT * (worldX - source.x);
    const floorY = source.y + rayT * (worldY - source.y);

    output.x = state.anchorX + (floorX - state.initialX) * PPM;
    output.y = state.baselineY - SIN_PITCH * floorY * PPM;
    return Number.isFinite(output.x) && Number.isFinite(output.y);
  };

  const drawMappedTriangle = (target, mask, maskScale, s0, s1, s2, d0, d1, d2, alpha) => {
    const sx1 = s1.x - s0.x;
    const sy1 = s1.y - s0.y;
    const sx2 = s2.x - s0.x;
    const sy2 = s2.y - s0.y;
    const dx1 = d1.x - d0.x;
    const dy1 = d1.y - d0.y;
    const dx2 = d2.x - d0.x;
    const dy2 = d2.y - d0.y;
    const determinant = sx1 * sy2 - sx2 * sy1;

    if (Math.abs(determinant) < 0.000001) return;

    const a = (dx1 * sy2 - dx2 * sy1) / determinant;
    const c = (sx1 * dx2 - sx2 * dx1) / determinant;
    const b = (dy1 * sy2 - dy2 * sy1) / determinant;
    const d = (sx1 * dy2 - sx2 * dy1) / determinant;
    const e = d0.x - a * s0.x - c * s0.y;
    const f = d0.y - b * s0.x - d * s0.y;

    const left = Math.min(s0.x, s1.x, s2.x);
    const top = Math.min(s0.y, s1.y, s2.y);
    const right = Math.max(s0.x, s1.x, s2.x);
    const bottom = Math.max(s0.y, s1.y, s2.y);

    target.save();
    target.globalAlpha = alpha;
    target.beginPath();
    target.moveTo(d0.x, d0.y);
    target.lineTo(d1.x, d1.y);
    target.lineTo(d2.x, d2.y);
    target.closePath();
    target.clip();
    target.transform(a, b, c, d, e, f);
    target.drawImage(
      mask,
      left * maskScale,
      top * maskScale,
      (right - left) * maskScale,
      (bottom - top) * maskScale,
      left,
      top,
      right - left,
      bottom - top
    );
    target.restore();
  };

  const computeShadowBounds = state => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const sample of LIGHT_SAMPLES) {
      if (
        !projectPointToFloor(state, 0, 0, sample, DEST_QUAD[0]) ||
        !projectPointToFloor(state, state.width, 0, sample, DEST_QUAD[1]) ||
        !projectPointToFloor(state, state.width, state.height, sample, DEST_QUAD[2]) ||
        !projectPointToFloor(state, 0, state.height, sample, DEST_QUAD[3])
      ) continue;

      for (const point of DEST_QUAD) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    }

    if (!Number.isFinite(minX)) return null;

    const left = clamp(Math.floor(minX - 3), 0, sceneWidth);
    const top = clamp(Math.floor(minY - 3), 0, sceneHeight);
    const right = clamp(Math.ceil(maxX + 3), 0, sceneWidth);
    const bottom = clamp(Math.ceil(maxY + 3), 0, sceneHeight);

    if (right <= left || bottom <= top) return null;

    return {
      left,
      top,
      width: right - left,
      height: bottom - top
    };
  };

  const drawGlyphShadow = (state, target) => {
    const bounds = computeShadowBounds(state);
    if (!bounds) return;

    // Reuse one scratch surface and clear only the current glyph's projected
    // bounds. This avoids a full hero-sized clear for every glyph on every frame.
    scratchCtx.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
    scratchCtx.globalCompositeOperation = "lighter";

    SOURCE_QUAD[0].x = 0;
    SOURCE_QUAD[0].y = 0;
    SOURCE_QUAD[1].x = state.width;
    SOURCE_QUAD[1].y = 0;
    SOURCE_QUAD[2].x = state.width;
    SOURCE_QUAD[2].y = state.height;
    SOURCE_QUAD[3].x = 0;
    SOURCE_QUAD[3].y = state.height;

    const sampleAlpha = SHADOW_STRENGTH / SAMPLE_COUNT;

    for (const sample of LIGHT_SAMPLES) {
      if (
        !projectPointToFloor(state, 0, 0, sample, DEST_QUAD[0]) ||
        !projectPointToFloor(state, state.width, 0, sample, DEST_QUAD[1]) ||
        !projectPointToFloor(state, state.width, state.height, sample, DEST_QUAD[2]) ||
        !projectPointToFloor(state, 0, state.height, sample, DEST_QUAD[3])
      ) continue;

      drawMappedTriangle(
        scratchCtx, state.mask, state.maskDpr,
        SOURCE_QUAD[0], SOURCE_QUAD[1], SOURCE_QUAD[2],
        DEST_QUAD[0], DEST_QUAD[1], DEST_QUAD[2],
        sampleAlpha
      );
      drawMappedTriangle(
        scratchCtx, state.mask, state.maskDpr,
        SOURCE_QUAD[0], SOURCE_QUAD[2], SOURCE_QUAD[3],
        DEST_QUAD[0], DEST_QUAD[2], DEST_QUAD[3],
        sampleAlpha
      );
    }

    scratchCtx.globalCompositeOperation = "source-over";
    target.drawImage(
      scratchCanvas,
      bounds.left * dpr,
      bounds.top * dpr,
      bounds.width * dpr,
      bounds.height * dpr,
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height
    );
    scratchCtx.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
  };

  const computeSupport = state => {
    const sinAngle = Math.sin(state.angle);
    const cosAngle = Math.cos(state.angle);
    const halfThickness = THICKNESS / 2;
    const localYs = [-halfThickness, halfThickness];
    const localZs = [state.minLocalZ, state.maxLocalZ];
    let minZ = Infinity;
    let sumRY = 0;
    let sumRZ = 0;
    let supportCount = 0;

    for (const localY of localYs) {
      for (const localZ of localZs) {
        const rY = cosAngle * localY - sinAngle * localZ;
        const rZ = sinAngle * localY + cosAngle * localZ;
        const worldZ = state.z + rZ;

        if (worldZ < minZ - 0.0005) {
          minZ = worldZ;
          sumRY = rY;
          sumRZ = rZ;
          supportCount = 1;
        } else if (Math.abs(worldZ - minZ) <= 0.0005) {
          sumRY += rY;
          sumRZ += rZ;
          supportCount++;
        }
      }
    }

    return {
      minZ,
      rY: sumRY / Math.max(1, supportCount),
      rZ: sumRZ / Math.max(1, supportCount)
    };
  };

  const simulateBody = (state, dt) => {
    state.vz -= GRAVITY * dt;
    state.y += state.vy * dt;
    state.z += state.vz * dt;
    state.angle += state.omega * dt;

    let support = computeSupport(state);
    let inContact = support.minZ <= 0.001;

    if (support.minZ < 0) {
      state.z -= support.minZ;
      support = computeSupport(state);
      inContact = true;
    }

    if (inContact) {
      const rY = support.rY;
      const rZ = support.rZ;
      const normalVelocity = state.vz + state.omega * rY;
      let normalImpulse = 0;

      if (normalVelocity < 0) {
        const normalMass = 1 / state.mass + (rY * rY) / state.inertia;
        normalImpulse = -(1 + RESTITUTION) * normalVelocity / normalMass;
        state.vz += normalImpulse / state.mass;
        state.omega += (rY * normalImpulse) / state.inertia;
      }

      const tangentVelocity = state.vy - state.omega * rZ;
      if (normalImpulse > 0 && Math.abs(tangentVelocity) > 0.00001) {
        const tangentMass = 1 / state.mass + (rZ * rZ) / state.inertia;
        const requestedImpulse = -tangentVelocity / tangentMass;
        const maximumImpulse = FRICTION * normalImpulse;
        const tangentImpulse = clamp(requestedImpulse, -maximumImpulse, maximumImpulse);

        state.vy += tangentImpulse / state.mass;
        state.omega -= (rZ * tangentImpulse) / state.inertia;
      }

      if (
        Math.abs(state.vy) < 0.025 &&
        Math.abs(state.vz) < 0.035 &&
        Math.abs(state.omega) < 0.035 &&
        support.minZ < 0.002
      ) {
        state.vy = 0;
        state.vz = 0;
        state.omega = 0;
        state.settled = true;
        state.pendingBake = true;
      }
    }
  };

  const bakeSettledShadow = state => {
    state.renderY = state.y;
    state.renderZ = state.z;
    state.renderAngle = state.angle;
    applyBody(state);
    drawGlyphShadow(state, staticCtx);
    state.pendingBake = false;
    state.body.style.willChange = "auto";
  };

  const renderFrame = alpha => {
    dynamicCtx.clearRect(0, 0, sceneWidth, sceneHeight);

    for (const state of states) {
      if (state.pendingBake) {
        bakeSettledShadow(state);
        continue;
      }
      if (state.settled) continue;

      state.renderY = lerp(state.previousY, state.y, alpha);
      state.renderZ = lerp(state.previousZ, state.z, alpha);
      state.renderAngle = lerp(state.previousAngle, state.angle, alpha);

      applyBody(state);
      drawGlyphShadow(state, dynamicCtx);
    }
  };

  const simulateStep = dt => {
    for (const state of states) {
      if (state.settled) continue;

      state.previousY = state.y;
      state.previousZ = state.z;
      state.previousAngle = state.angle;

      if (state.delay > 0) {
        state.delay = Math.max(0, state.delay - dt);
        continue;
      }

      simulateBody(state, dt);
    }
  };

  const hasActiveBodies = () => states.some(state => !state.settled);

  const frame = time => {
    animationId = 0;
    if (disposed || document.hidden || !started) return;

    if (!lastTime) lastTime = time;
    const elapsed = Math.min(MAX_FRAME_DT, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    accumulator += elapsed;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      simulateStep(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME && accumulator >= FIXED_DT) {
      accumulator = 0;
    }

    renderFrame(accumulator / FIXED_DT);

    if (hasActiveBodies()) {
      animationId = requestAnimationFrame(frame);
    } else {
      started = false;
      lastTime = 0;
      accumulator = 0;
    }
  };

  const scheduleFrame = () => {
    if (disposed || document.hidden || !started || animationId) return;
    animationId = requestAnimationFrame(frame);
  };

  const renderCurrentScene = () => {
    staticCtx.clearRect(0, 0, sceneWidth, sceneHeight);
    dynamicCtx.clearRect(0, 0, sceneWidth, sceneHeight);

    for (const state of states) {
      state.renderY = state.y;
      state.renderZ = state.z;
      state.renderAngle = state.angle;
      applyBody(state);

      if (state.settled) drawGlyphShadow(state, staticCtx);
      else drawGlyphShadow(state, dynamicCtx);
    }
  };

  const resizeScene = () => {
    if (disposed) return;

    const oldDpr = dpr;
    const oldWidth = sceneWidth;
    const oldHeight = sceneHeight;
    setCanvasSize();

    const changed = oldDpr !== dpr || oldWidth !== sceneWidth || oldHeight !== sceneHeight;
    if (!changed) return;

    for (const state of states) {
      const oldBottom = state.z - state.heightM / 2;
      measureGlyph(state);

      const newInitialX = state.anchorX / PPM;
      state.x += newInitialX - state.initialX;
      state.initialX = newInitialX;

      state.heightM = state.height / PPM;
      state.z = oldBottom + state.heightM / 2;
      updateMassProperties(state);
      makeMask(state);

      state.previousY = state.y;
      state.previousZ = state.z;
      state.previousAngle = state.angle;
      state.renderY = state.y;
      state.renderZ = state.z;
      state.renderAngle = state.angle;
    }

    updateLightSamples();
    renderCurrentScene();
  };

  const reducedMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  setCanvasSize();
  for (const state of states) makeMask(state);

  if (reducedMotion) {
    for (const state of states) {
      state.y = 0;
      state.z = state.heightM / 2;
      state.vy = 0;
      state.vz = 0;
      state.angle = 0;
      state.omega = 0;
      state.settled = true;
    }
  }

  updateLightSamples();
  renderCurrentScene();

  const onVisibilityChange = () => {
    if (document.hidden) {
      if (animationId) cancelAnimationFrame(animationId);
      animationId = 0;
      lastTime = 0;
      accumulator = 0;
    } else {
      lastTime = 0;
      scheduleFrame();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("resize", resizeScene, { passive: true });

  let resizeObserver = null;
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(resizeScene);
    resizeObserver.observe(hero);
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (!disposed) resizeScene();
    });
  }

  const onPageHide = () => {
    disposed = true;
    if (animationId) cancelAnimationFrame(animationId);
    animationId = 0;
    if (resizeObserver) resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("resize", resizeScene);
  };
  window.addEventListener("pagehide", onPageHide, { once: true });

  window.startKaelithFall = () => {
    if (loader && loader.dataset.loaderFinished !== "true") return;
    if (startRequested || reducedMotion || disposed) return;
    startRequested = true;

    window.setTimeout(() => {
      if (disposed) return;
      started = true;
      lastTime = 0;
      accumulator = 0;
      for (const state of states) {
        if (!state.settled) state.body.style.willChange = "transform";
      }
      scheduleFrame();
    }, 260);
  };

  if (!loader || loader.dataset.loaderFinished === "true") {
    window.startKaelithFall();
  }
})();