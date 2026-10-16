// ============================================================
// Tokamak Particle Simulation — Three.js 3D 渲染
//
// 场景元素：
//   - 半透明环形真空室（大半径 R0、小半径 a）
//   - 环形场线圈（TF 线圈，环向 8 根立式环）
//   - 中心柱（中心螺线管）、磁轴环
//   - 磁场螺旋线（磁面结构，可视化）
//   - 发光粒子 + 光晕 + 渐变轨迹
//   - 三光源 + ACES + Bloom 辉光
//
// 视图：OrbitControls 自由旋转 + 预设机位按钮（默认/俯视/侧视/正视）
//
// 注意：本文件是普通脚本（非 module），依赖 index.html 中
// module 脚本把 THREE / OrbitControls / 后处理挂载到 window。
// ============================================================

// Global state
let scene;
let camera;
let renderer;
let controls;
let composer;

let particle;
let particleGlow;
let trajectoryLine;

let fieldLineGroup;
let vesselMesh;
let plasmaMesh;
let tfCoilGroup;
let axisRing;
let columnMesh;

let trajectoryPoints = [];
let times = [];

let currentIndex = 0;
let isPlaying = false;
let animationSpeed = 1;

// 当前装置尺寸（用于相机取景与视图切换）
let deviceR0 = 2.0;
let deviceA = 0.6;
let currentView = "default";


// ============================================================
// Start application
// ============================================================

window.startSimulationApp = function () {

    console.log("Starting tokamak simulation app...");

    initializeThreeJS();
    setupButtons();
    setupViewButtons();

};


// ============================================================
// Initialize Three.js
// ============================================================

function initializeThreeJS() {

    const THREE = window.THREE;
    const OrbitControls = window.OrbitControls;

    if (!THREE) { console.error("Three.js was not loaded."); return; }
    if (!OrbitControls) { console.error("OrbitControls was not loaded."); return; }
    if (!window.EffectComposer || !window.RenderPass || !window.UnrealBloomPass) {
        console.error("Post-processing modules were not loaded."); return;
    }

    const viewer = document.getElementById("viewer");
    if (!viewer) { console.error("Viewer element not found."); return; }

    const width = viewer.clientWidth;
    const height = viewer.clientHeight;

    // --------------------------------------------------------
    // Scene
    // --------------------------------------------------------

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04060a);

    // --------------------------------------------------------
    // Camera
    // --------------------------------------------------------

    camera = new THREE.PerspectiveCamera(45, width / height, 0.001, 500);
    camera.position.set(4, 3, 5);
    camera.lookAt(0, 0, 0);

    // --------------------------------------------------------
    // Renderer
    // --------------------------------------------------------

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    viewer.appendChild(renderer.domElement);

    // --------------------------------------------------------
    // Camera controls
    // --------------------------------------------------------

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    // --------------------------------------------------------
    // Lights
    // --------------------------------------------------------

    const hemiLight = new THREE.HemisphereLight(0x6f8fb8, 0x0d1116, 0.6);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfff0e0, 1.9);
    dirLight.position.set(6, 8, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x4488ff, 0.7);
    fillLight.position.set(-5, -3, -6);
    scene.add(fillLight);

    // --------------------------------------------------------
    // 实验台地面 + 网格
    // --------------------------------------------------------

    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.MeshStandardMaterial({
            color: 0x0e141c, roughness: 0.7, metalness: 0.25
        })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(16, 24, 0x2c3947, 0x18222c);
    grid.position.y = -2.19;
    scene.add(grid);

    // --------------------------------------------------------
    // Coordinate axes
    // --------------------------------------------------------

    const axes = new THREE.AxesHelper(2.0);
    scene.add(axes);

    // --------------------------------------------------------
    // Particle（发光核心 + 光晕）
    // --------------------------------------------------------

    const particleGeometry = new THREE.SphereGeometry(0.05, 24, 24);
    const particleMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x66ffff,
        emissiveIntensity: 2.2,
        roughness: 0.3,
        metalness: 0.1
    });
    particle = new THREE.Mesh(particleGeometry, particleMaterial);
    particle.visible = false;

    const glowTexture = createGlowTexture();
    const glowMaterial = new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0x66ffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    particleGlow = new THREE.Sprite(glowMaterial);
    particleGlow.scale.set(0.5, 0.5, 1);
    particle.add(particleGlow);
    scene.add(particle);

    // --------------------------------------------------------
    // Post-processing（Bloom 辉光）
    // --------------------------------------------------------

    composer = new window.EffectComposer(renderer);
    composer.addPass(new window.RenderPass(scene, camera));

    const bloomPass = new window.UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.6,   // strength
        0.45,  // radius
        0.82   // threshold
    );
    composer.addPass(bloomPass);

    // --------------------------------------------------------
    // Window resize
    // --------------------------------------------------------

    window.addEventListener("resize", resizeRenderer);

    animate();

}


// ============================================================
// 生成径向渐变光晕贴图
// ============================================================

function createGlowTexture() {

    const THREE = window.THREE;
    const size = 128;

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    const g = ctx.createRadialGradient(
        size / 2, size / 2, 0,
        size / 2, size / 2, size / 2
    );
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(120,255,255,0.8)");
    g.addColorStop(0.6, "rgba(0,220,255,0.25)");
    g.addColorStop(1, "rgba(0,180,255,0)");

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    return new THREE.CanvasTexture(canvas);
}


// ============================================================
// Animation loop
// ============================================================

function animate() {

    requestAnimationFrame(animate);

    if (isPlaying && trajectoryPoints.length > 0) {
        currentIndex += animationSpeed;
        currentIndex = Math.floor(currentIndex);
        if (currentIndex >= trajectoryPoints.length) {
            currentIndex = trajectoryPoints.length - 1;
            isPlaying = false;
        }
        updateParticle(currentIndex);
    }

    // 粒子光晕脉动
    if (particle && particle.visible && particleGlow) {
        const pulse = 1 + 0.12 * Math.sin(Date.now() / 120);
        particleGlow.scale.set(0.5 * pulse, 0.5 * pulse, 1);
        particle.rotation.y += 0.05;
    }

    if (controls) controls.update();

    if (composer) {
        composer.render();
    } else if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }

}


// ============================================================
// 场景几何（每次模拟后重建）
// ============================================================

function buildSceneGeometry(data) {

    const THREE = window.THREE;
    const R0 = data.R0;
    const a = data.a;

    deviceR0 = R0;
    deviceA = a;

    // 移除旧几何
    removeSceneGeometry();

    // --------------------------------------------------------
    // 环形真空室（半透明）
    // --------------------------------------------------------

    const vesselMat = new THREE.MeshPhysicalMaterial({
        color: 0x2a3f55,
        transparent: true,
        opacity: 0.16,
        roughness: 0.4,
        metalness: 0.35,
        side: THREE.DoubleSide
    });
    vesselMesh = new THREE.Mesh(
        new THREE.TorusGeometry(R0, a, 48, 96),
        vesselMat
    );
    scene.add(vesselMesh);

    // --------------------------------------------------------
    // 等离子体（内部发光）
    // --------------------------------------------------------

    const plasmaMat = new THREE.MeshStandardMaterial({
        color: 0xff5a3c,
        emissive: 0xff4422,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.22,
        roughness: 0.5,
        metalness: 0.1,
        side: THREE.DoubleSide
    });
    plasmaMesh = new THREE.Mesh(
        new THREE.TorusGeometry(R0, a * 0.92, 48, 96),
        plasmaMat
    );
    scene.add(plasmaMesh);

    // --------------------------------------------------------
    // 磁轴环（z=0 平面，半径 R0）
    // --------------------------------------------------------

    axisRing = createCircleRing(R0, 0.02, 0xffcc66, 0xcc9933);
    scene.add(axisRing);

    // --------------------------------------------------------
    // 中心柱（中心螺线管）
    // --------------------------------------------------------

    const colR = Math.max(a * 0.22, 0.05);
    columnMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(colR, colR, a * 2.4, 24),
        new THREE.MeshStandardMaterial({
            color: 0x3a4652,
            roughness: 0.5,
            metalness: 0.5
        })
    );
    scene.add(columnMesh);

    // --------------------------------------------------------
    // 环形场线圈（TF 线圈，8 根立式环）
    // --------------------------------------------------------

    tfCoilGroup = new THREE.Group();
    const nTF = 8;
    const coilR = R0 + a * 1.15;
    for (let i = 0; i < nTF; i++) {
        const phi = 2 * Math.PI * i / nTF;
        const ring = createVerticalRing(coilR, phi, 0.025, 0x5a7fa0);
        tfCoilGroup.add(ring);
    }
    scene.add(tfCoilGroup);

    // --------------------------------------------------------
    // 磁场螺旋线（磁面结构）
    // --------------------------------------------------------

    fieldLineGroup = new THREE.Group();
    const lines = data.field_lines || [];
    for (let li = 0; li < lines.length; li++) {
        const line = createFieldLine(lines[li], li, lines.length);
        fieldLineGroup.add(line);
    }
    scene.add(fieldLineGroup);
}


// ============================================================
// 创建闭合圆环（z=0 平面，半径 radius）
// ============================================================

function createCircleRing(radius, tube, color, emissive) {

    const THREE = window.THREE;

    const points = [];
    const seg = 128;
    for (let i = 0; i <= seg; i++) {
        const t = 2 * Math.PI * i / seg;
        points.push(new THREE.Vector3(radius * Math.cos(t), radius * Math.sin(t), 0));
    }

    const curve = new THREE.CatmullRomCurve3(points, true);
    const geo = new THREE.TubeGeometry(curve, 128, tube, 8, true);

    const mat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: emissive || color,
        emissiveIntensity: 0.4,
        metalness: 0.6,
        roughness: 0.35
    });

    return new THREE.Mesh(geo, mat);
}


// ============================================================
// 创建立式环（TF 线圈）：在 toroidal 角 phi 处的竖直平面圆环
// ============================================================

function createVerticalRing(radius, phi, tube, color) {

    const THREE = window.THREE;

    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);

    const points = [];
    const seg = 128;
    for (let i = 0; i <= seg; i++) {
        const t = 2 * Math.PI * i / seg;
        // 竖直平面圆：eR(phi) 与 eZ 张成的平面
        const rr = radius * Math.cos(t);
        points.push(new THREE.Vector3(rr * cosP, rr * sinP, radius * Math.sin(t)));
    }

    const curve = new THREE.CatmullRomCurve3(points, true);
    const geo = new THREE.TubeGeometry(curve, 128, tube, 8, true);

    const mat = new THREE.MeshStandardMaterial({
        color: color,
        metalness: 0.8,
        roughness: 0.3
    });

    return new THREE.Mesh(geo, mat);
}


// ============================================================
// 创建磁场螺旋线（渐变发光）
// ============================================================

function createFieldLine(pts, index, total) {

    const THREE = window.THREE;

    const vectorPoints = pts.map(p => new THREE.Vector3(p[0], p[1], p[2]));

    const geo = new THREE.BufferGeometry().setFromPoints(vectorPoints);

    const count = vectorPoints.length;
    const colors = new Float32Array(count * 3);
    const hueBase = (index / Math.max(total, 1)) * 0.6; // 0..0.6

    for (let i = 0; i < count; i++) {
        const t = count <= 1 ? 0 : i / (count - 1);
        // 蓝 -> 青 -> 品红 渐变
        colors[i * 3 + 0] = 0.12 + 0.25 * t + 0.45 * hueBase;
        colors[i * 3 + 1] = 0.55 + 0.30 * t - 0.20 * hueBase;
        colors[i * 3 + 2] = 1.00;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.55
    });

    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    return line;
}


// ============================================================
// 创建渐变轨迹（发光）
// ============================================================

function createTrajectory(points) {

    const THREE = window.THREE;

    const vectorPoints = points.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const geo = new THREE.BufferGeometry().setFromPoints(vectorPoints);

    const count = vectorPoints.length;
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        const t = count <= 1 ? 0 : i / (count - 1);
        // 蓝紫 -> 亮青 -> 暖白 渐变
        colors[i * 3 + 0] = 0.20 + 0.70 * t;
        colors[i * 3 + 1] = 0.45 + 0.45 * t;
        colors[i * 3 + 2] = 1.00 - 0.15 * t;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.95
    });

    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    return line;
}


// ============================================================
// 移除旧几何
// ============================================================

function removeSceneGeometry() {

    if (trajectoryLine) {
        scene.remove(trajectoryLine);
        trajectoryLine.geometry.dispose();
        trajectoryLine.material.dispose();
        trajectoryLine = null;
    }

    if (fieldLineGroup) {
        scene.remove(fieldLineGroup);
        fieldLineGroup = null;
    }

    if (vesselMesh) {
        scene.remove(vesselMesh);
        vesselMesh.geometry.dispose();
        vesselMesh.material.dispose();
        vesselMesh = null;
    }

    if (plasmaMesh) {
        scene.remove(plasmaMesh);
        plasmaMesh.geometry.dispose();
        plasmaMesh.material.dispose();
        plasmaMesh = null;
    }

    if (tfCoilGroup) {
        scene.remove(tfCoilGroup);
        tfCoilGroup = null;
    }

    if (axisRing) {
        scene.remove(axisRing);
        axisRing.geometry.dispose();
        axisRing.material.dispose();
        axisRing = null;
    }

    if (columnMesh) {
        scene.remove(columnMesh);
        columnMesh.geometry.dispose();
        columnMesh.material.dispose();
        columnMesh = null;
    }

}


// ============================================================
// Update particle position
// ============================================================

function updateParticle(index) {

    if (!particle || trajectoryPoints.length === 0) return;

    const p = trajectoryPoints[index];
    particle.position.set(p[0], p[1], p[2]);
    particle.visible = true;

    const timeline = document.getElementById("timeline");
    if (timeline) {
        timeline.max = trajectoryPoints.length - 1;
        timeline.value = index;
    }

    const timeDisplay = document.getElementById("time-display");
    if (timeDisplay && times.length > index) {
        timeDisplay.textContent = "t = " + formatScientific(times[index]) + " s";
    }
}


// ============================================================
// 相机取景
// ============================================================

function setCameraView(viewName) {

    const outer = deviceR0 + deviceA;
    const dist = 2.6 * outer;

    const views = {
        "default": [0.75 * dist, 0.55 * dist, 1.00 * dist],
        "top":     [0,          1.20 * dist,  0],
        "side":    [1.20 * dist, 0.50 * dist, 0],
        "front":   [0,          0.50 * dist,  1.20 * dist]
    };

    const pos = views[viewName] || views["default"];

    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();

    currentView = viewName;

    // 高亮当前视图按钮
    document.querySelectorAll(".view-btn").forEach(function (btn) {
        btn.classList.remove("active");
    });
    const activeBtn = document.getElementById("view-" + viewName);
    if (activeBtn) activeBtn.classList.add("active");
}


// ============================================================
// Run simulation（本地物理引擎，无需后端）
// ============================================================

function runSimulation() {

    console.log("Running tokamak simulation...");

    const params = {
        R0: parseFloat(document.getElementById("R0").value),
        a: parseFloat(document.getElementById("a").value),
        B0: parseFloat(document.getElementById("B0").value),
        q: parseFloat(document.getElementById("q").value),
        qCharge: parseFloat(document.getElementById("qCharge").value),
        m: parseFloat(document.getElementById("m").value),
        rSurf: parseFloat(document.getElementById("rSurf").value),
        vPar: parseFloat(document.getElementById("vPar").value),
        vPerp: parseFloat(document.getElementById("vPerp").value),
        toroidalTurns: parseFloat(document.getElementById("toroidalTurns").value),
        stepsPerGyro: parseInt(document.getElementById("stepsPerGyro").value)
    };

    console.log("Parameters:", params);

    let result;
    try {
        result = window.runTokamakSimulation(params);
    } catch (e) {
        console.error(e);
        alert("模拟失败：\n" + e.message);
        return;
    }

    if (!result || result.success === false) {
        alert("模拟失败：\n" + (result ? result.error : "未知错误"));
        return;
    }

    const data = result;

    trajectoryPoints = data.positions;
    times = data.times;
    currentIndex = 0;
    isPlaying = false;

    // 重建场景几何
    buildSceneGeometry(data);

    // 轨迹线
    trajectoryLine = createTrajectory(trajectoryPoints);
    scene.add(trajectoryLine);

    // 粒子复位
    updateParticle(0);

    // 取景（默认视角）
    setCameraView(currentView);

    // 更新结果
    updateResults(data);

    console.log("Simulation completed.");
}


// ============================================================
// Update result cards
// ============================================================

function updateResults(data) {

    setText("B-launch", formatScientific(data.B_launch) + " T");
    setText("B-phi", formatScientific(data.B_toroidal_launch) + " T");
    setText("B-theta", formatScientific(data.B_poloidal_launch) + " T");
    setText("pitch", data.pitch_angle_deg.toFixed(2) + "°");
    setText("q-local", "q(磁轴)=" + data.q.toFixed(2) + " · q(r₀)=" + data.q_actual_launch.toFixed(3));
    setText("cyc-period", formatScientific(data.cyclotron_period) + " s");
    setText("gyro-radius", formatScientific(data.gyro_radius) + " m");
    setText("confinement", data.r_max_over_a.toFixed(4) + " (r₀/a=" + (data.r_surf / data.a).toFixed(3) + ")");
    setText("energy-error", data.energy_error_percent.toFixed(4) + " %");
    setText("steps-time", data.num_steps.toLocaleString() + " / " + formatScientific(data.total_time) + " s");
}


// ============================================================
// Helpers
// ============================================================

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}


function formatScientific(value) {
    return Number(value).toExponential(3);
}


// ============================================================
// Buttons
// ============================================================

function setupButtons() {

    const runButton = document.getElementById("run-button");
    const playButton = document.getElementById("play-button");
    const pauseButton = document.getElementById("pause-button");
    const resetButton = document.getElementById("reset-button");
    const timeline = document.getElementById("timeline");

    if (runButton) runButton.addEventListener("click", runSimulation);

    if (playButton) playButton.addEventListener("click", function () {
        if (trajectoryPoints.length > 0) isPlaying = true;
    });

    if (pauseButton) pauseButton.addEventListener("click", function () {
        isPlaying = false;
    });

    if (resetButton) resetButton.addEventListener("click", function () {
        isPlaying = false;
        currentIndex = 0;
        updateParticle(0);
    });

    if (timeline) timeline.addEventListener("input", function () {
        isPlaying = false;
        currentIndex = parseInt(timeline.value);
        updateParticle(currentIndex);
    });
}


// ============================================================
// 视图切换按钮
// ============================================================

function setupViewButtons() {

    const map = {
        "view-default": "default",
        "view-top": "top",
        "view-side": "side",
        "view-front": "front"
    };

    for (const id in map) {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener("click", function () {
                setCameraView(map[id]);
            });
        }
    }
}


// ============================================================
// Resize
// ============================================================

function resizeRenderer() {

    const viewer = document.getElementById("viewer");
    if (!viewer || !renderer || !camera) return;

    const w = viewer.clientWidth;
    const h = viewer.clientHeight;

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);

    if (composer) composer.setSize(w, h);
}
