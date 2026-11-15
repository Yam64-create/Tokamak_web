// ============================================================
// Tokamak Particle Simulation — Three.js 3D 渲染
//
// 场景元素：
//   - GSFit 导出的 PF 线圈（11 组 / 364 根 filament，真实几何）
//   - GSFit 重建的磁面（5 层嵌套闭合面 + LCFS 等离子体边界）
//   - 环向场线圈（示意，8 根立式环，TF 只有标量约定无几何）
//   - 磁场线（沿真实磁场积分）
//   - 发光粒子 + 渐变轨迹
//   - 三光源 + ACES + Bloom 辉光
//
// 两种数据源：
//   gsfit    ST40 shot 12050 @130 ms（GSFit 逆平衡重建）
//   analytic 旧的解析示意模型
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
let surfaceGroup;
let coilMesh;
let insulationMesh;
let vesselMesh;
let plasmaMesh;
let tfCoilGroup;
let axisRing;
let columnMesh;
let floorMesh;
let gridHelper;

// 绝缘护套显示开关（页面上可切换）
let showInsulation = true;

let trajectoryPoints = [];
let times = [];

let currentIndex = 0;
let isPlaying = false;
let animationSpeed = 1;

// 当前装置尺寸（用于相机取景与视图切换）
let deviceR0 = 0.5155;
let deviceA = 0.1863;
let deviceOuter = 0.9;      // 最外层几何半径（取景用）
let deviceZmax = 0.3;       // 最外层几何高度（地面高度用）
let currentView = "default";

// 帧率统计
let fpsFrames = 0;
let fpsLastTime = 0;


// ============================================================
// Start application
// ============================================================

window.startSimulationApp = function () {

    console.log("Starting tokamak simulation app...");

    initGSFitData();
    initializeThreeJS();
    setupButtons();
    setupViewButtons();
    setupFieldMode();
    setupDisplayToggles();

    // 首次进入自动跑一次，直接展示装置与轨迹
    setTimeout(runSimulation, 300);

};


// ============================================================
// 初始化 GSFit 数据（psi 网格 + 线圈表 -> 磁场模块）
// ============================================================

function initGSFitData() {

    if (!window.GSFIT_DATA) {
        console.warn("gsfit_data.js 未加载，仅可使用解析模型。");
        return;
    }

    if (!window.GSFitField) {
        console.warn("gsfit_field.js 未加载，仅可使用解析模型。");
        return;
    }

    try {
        window.GSFitField.init(window.GSFIT_DATA);
        console.log("GSFit 数据已初始化：",
            window.GSFIT_DATA.meta.machine,
            "shot", window.GSFIT_DATA.meta.pulse);
    } catch (e) {
        console.error("GSFit 数据初始化失败：", e);
    }
}


// ============================================================
// Initialize Three.js
// ============================================================

// ============================================================
// 程序化影棚环境贴图（equirectangular）
// PBR 金属没有环境反射会像塑料，这里用 canvas 现画一张：
// 上亮下暗的天光渐变 + 两块柔光箱，供铜导体反射。
// ============================================================

function createStudioEnvironment() {

    const THREE = window.THREE;

    const w = 1024;
    const h = 512;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0.00, "#eaf2ff");
    sky.addColorStop(0.42, "#93a8bf");
    sky.addColorStop(0.56, "#3a4655");
    sky.addColorStop(1.00, "#0a0d12");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    function softbox(cx, cy, rx, ry, alpha) {

        const r = Math.max(rx, ry);

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, "rgba(255,255,255," + alpha + ")");
        g.addColorStop(0.6, "rgba(255,255,255," + (alpha * 0.35) + ")");
        g.addColorStop(1, "rgba(255,255,255,0)");

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx / r, ry / r);
        ctx.translate(-cx, -cy);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    softbox(w * 0.22, h * 0.18, 230, 130, 0.95);
    softbox(w * 0.68, h * 0.26, 180, 100, 0.65);
    softbox(w * 0.90, h * 0.34, 120, 70, 0.45);

    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    return tex;
}


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

    // 程序化环境贴图：让铜导体与绝缘护套有真实的反射/高光层次
    scene.environment = createStudioEnvironment();

    // 调试句柄（控制台可直接查看场景对象）
    window.__tokamak = {
        get scene() { return scene; },
        get camera() { return camera; },
        get deviceOuter() { return deviceOuter; }
    };

    // --------------------------------------------------------
    // Camera
    // --------------------------------------------------------

    camera = new THREE.PerspectiveCamera(45, width / height, 0.001, 500);
    camera.position.set(1.5, 1.1, 1.9);
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

    floorMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.MeshStandardMaterial({
            color: 0x0e141c, roughness: 0.7, metalness: 0.25
        })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -1.2;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    gridHelper = new THREE.GridHelper(16, 24, 0x2c3947, 0x18222c);
    gridHelper.position.y = -1.19;
    scene.add(gridHelper);

    // --------------------------------------------------------
    // Coordinate axes
    // --------------------------------------------------------

    const axes = new THREE.AxesHelper(1.5);
    scene.add(axes);

    // --------------------------------------------------------
    // Particle（发光核心 + 光晕）
    // --------------------------------------------------------

    const particleGeometry = new THREE.SphereGeometry(0.012, 24, 24);
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
    particleGlow.scale.set(0.12, 0.12, 1);
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
        particleGlow.scale.set(0.12 * pulse, 0.12 * pulse, 1);
        particle.rotation.y += 0.05;
    }

    if (controls) controls.update();

    try {
        if (composer) {
            composer.render();
        } else if (renderer && scene && camera) {
            renderer.render(scene, camera);
        }
    } catch (e) {
        console.error("渲染失败：", e && e.message);
    }

    // 帧率显示（每 0.5 s 更新一次）
    fpsFrames++;

    const now = performance.now();

    if (now - fpsLastTime > 500) {
        const fps = Math.round(fpsFrames / ((now - fpsLastTime) / 1000));
        const statusEl = document.getElementById("status");
        if (statusEl) statusEl.textContent = "LOCAL ENGINE · " + fps + " FPS";
        fpsFrames = 0;
        fpsLastTime = now;
    }

}


// ============================================================
// 场景几何（每次模拟后重建）
// ============================================================

function buildSceneGeometry(data) {

    const THREE = window.THREE;

    deviceR0 = data.R0;
    deviceA = data.a;
    deviceOuter = deviceR0 + deviceA * 1.4;
    deviceZmax = deviceA * 1.4;

    removeSceneGeometry();

    const GSFIT = window.GSFIT_DATA;

    if (data.mode === "gsfit" && GSFIT) {
        buildGSFitScene(data, GSFIT);
    } else {
        buildAnalyticScene(data);
    }

    // 地面高度随装置尺寸调整
    const floorY = -deviceZmax * 1.08;
    if (floorMesh) floorMesh.position.y = floorY;
    if (gridHelper) gridHelper.position.y = floorY + 0.01;

    // --------------------------------------------------------
    // 磁场线（两种模式共用）
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
// GSFit 场景：真实线圈 + 真实磁面
// ============================================================

function buildGSFitScene(data, GSFIT) {

    const THREE = window.THREE;

    // --------------------------------------------------------
    // PF 线圈（364 根 filament 合并成一个 mesh）
    // --------------------------------------------------------

    // 取景半径按线圈最外缘计算
    let coilRMax = 0;
    let coilZMax = 0;
    for (let gi = 0; gi < GSFIT.coils.length; gi++) {
        const gf = GSFIT.coils[gi].filaments;
        for (let fi = 0; fi < gf.length; fi++) {
            const rOut = gf[fi][0] + Math.max(gf[fi][2], gf[fi][3]) * 0.5;
            const zOut = Math.abs(gf[fi][1]) + Math.max(gf[fi][2], gf[fi][3]) * 0.5;
            if (rOut > coilRMax) coilRMax = rOut;
            if (zOut > coilZMax) coilZMax = zOut;
        }
    }
    deviceOuter = coilRMax;
    deviceZmax = coilZMax;

    const coilGeo = buildCoilGeometry(GSFIT.coils);

    // 写实铜导体：高金属度 + 低粗糙度 + 环境反射
    coilMesh = new THREE.Mesh(
        coilGeo,
        new THREE.MeshStandardMaterial({
            vertexColors: true,
            metalness: 0.92,
            roughness: 0.34,
            envMapIntensity: 1.25
        })
    );
    coilMesh.castShadow = true;
    scene.add(coilMesh);

    // --------------------------------------------------------
    // 绝缘护套（包裹每组绕组，半透明环氧）
    // --------------------------------------------------------

    const insGeo = buildInsulationGeometry(GSFIT.coils);

    insulationMesh = new THREE.Mesh(
        insGeo,
        new THREE.MeshPhysicalMaterial({
            color: 0xd9e2e8,
            metalness: 0.0,
            roughness: 0.28,
            clearcoat: 0.6,
            clearcoatRoughness: 0.18,
            transparent: true,
            opacity: 0.16,
            side: THREE.DoubleSide,
            depthWrite: false,
            envMapIntensity: 1.4
        })
    );
    insulationMesh.visible = showInsulation;
    insulationMesh.renderOrder = 2;
    scene.add(insulationMesh);

    // --------------------------------------------------------
    // 磁面（5 层嵌套闭合面）
    // --------------------------------------------------------

    surfaceGroup = new THREE.Group();

    for (let i = 0; i < GSFIT.surfaces.length; i++) {

        const t = i / Math.max(GSFIT.surfaces.length - 1, 1);

        const mesh = createLatheSurface(
            GSFIT.surfaces[i].points,
            0x2f6f8f,
            0x1c4d66,
            {
                opacity: 0.16 + 0.10 * t,
                emissiveIntensity: 0.35
            }
        );

        surfaceGroup.add(mesh);
    }

    scene.add(surfaceGroup);

    // --------------------------------------------------------
    // 等离子体本体（LCFS）
    // --------------------------------------------------------

    plasmaMesh = createLatheSurface(
        GSFIT.lcfs,
        0xff5a3c,
        0xff4422,
        {
            opacity: 0.26,
            emissiveIntensity: 0.45,
            side: THREE.DoubleSide
        }
    );

    scene.add(plasmaMesh);

    // --------------------------------------------------------
    // 真空室（LCFS 外扩 1.12 倍）
    // --------------------------------------------------------

    const vesselPts = GSFIT.lcfs.map(function (p) {
        const Rc = GSFIT.equilibrium.R0LCFS;
        return [
            Rc + (p[0] - Rc) * 1.14,
            p[1] * 1.14
        ];
    });

    vesselMesh = createLatheSurface(
        vesselPts,
        0x2a3f55,
        0x101820,
        {
            opacity: 0.10,
            emissiveIntensity: 0.08,
            side: THREE.DoubleSide
        }
    );

    scene.add(vesselMesh);

    // --------------------------------------------------------
    // 磁轴环（金色）
    // --------------------------------------------------------

    axisRing = createCircleRing(data.R0, 0.006, 0xffcc66, 0xcc9933);
    axisRing.position.z = data.axisZ || 0;
    scene.add(axisRing);

    // --------------------------------------------------------
    // 环向场线圈（示意：GSFit 只存 B_phi0 约定，无 TF 几何）
    //   以磁轴为中心、半径约 2a 的 D 形近似（内腿贴近中心柱）
    // --------------------------------------------------------

    tfCoilGroup = new THREE.Group();

    const nTF = 8;
    const tfRadius = deviceA * 1.9;

    for (let i = 0; i < nTF; i++) {
        const phi = 2 * Math.PI * i / nTF;
        const ring = createVerticalRing(deviceR0, tfRadius, phi, 0.008, 0x2a3948);
        tfCoilGroup.add(ring);
    }

    scene.add(tfCoilGroup);
}


// ============================================================
// 解析模型场景（旧版示意几何）
// ============================================================

function buildAnalyticScene(data) {

    const THREE = window.THREE;

    const R0 = data.R0;
    const a = data.a;

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

    axisRing = createCircleRing(R0, 0.02, 0xffcc66, 0xcc9933);
    scene.add(axisRing);

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

    tfCoilGroup = new THREE.Group();
    const nTF = 8;
    for (let i = 0; i < nTF; i++) {
        const phi = 2 * Math.PI * i / nTF;
        const ring = createVerticalRing(0, R0 + a * 1.15, phi, 0.025, 0x5a7fa0);
        tfCoilGroup.add(ring);
    }
    scene.add(tfCoilGroup);
}


// ============================================================
// 由 filament 表构建线圈几何（一次 draw call）
//
// 每个 filament 是一个闭合圆环（半径 R，高度 Z），围绕圆环扫出细管。
// 颜色按线圈组区分（同名组共用一色），便于识别极向场线圈分布。
// ============================================================

const COIL_COLORS = {
    BVLB: [0.82, 0.55, 0.30],
    BVLT: [0.82, 0.55, 0.30],
    BVUB: [0.70, 0.44, 0.22],
    BVUT: [0.70, 0.44, 0.22],
    DIVB: [0.90, 0.65, 0.38],
    DIVT: [0.90, 0.65, 0.38],
    MCB:  [0.62, 0.45, 0.28],
    MCT:  [0.62, 0.45, 0.28],
    PSHB: [0.58, 0.52, 0.46],
    PSHT: [0.58, 0.52, 0.46],
    SOL:  [0.72, 0.45, 0.22]
};


// ============================================================
// 矩形截面环形导体（真实绕组的一匝）
//
// 截面 = 径向 dR × 竖直 dZ 的矩形，绕 Z 轴回转成分段圆环；
// positions / normals / indices 累加进调用方的数组，colors 可空。
// ============================================================

function pushRingBox(positions, normals, colors, indices,
                     centerR, centerZ, halfR, halfZ, segments, color) {

    // 矩形截面四个角点（逆时针：外下-外上-内上-内下）
    const prof = [
        [centerR + halfR, centerZ - halfZ],
        [centerR + halfR, centerZ + halfZ],
        [centerR - halfR, centerZ + halfZ],
        [centerR - halfR, centerZ - halfZ]
    ];

    const baseVertex = positions.length / 3;

    for (let e = 0; e < 4; e++) {

        const p0 = prof[e];
        const p1 = prof[(e + 1) % 4];

        // 该截面边的外法向（R-Z 平面内，垂直于截面边）
        let nr = p1[1] - p0[1];
        let nz = -(p1[0] - p0[0]);

        const nlen = Math.sqrt(nr * nr + nz * nz) || 1;
        nr /= nlen;
        nz /= nlen;

        for (let i = 0; i <= segments; i++) {

            const phi = 2 * Math.PI * i / segments;
            const c = Math.cos(phi);
            const s = Math.sin(phi);

            positions.push(p0[0] * c, p0[0] * s, p0[1]);
            normals.push(nr * c, nr * s, nz);
            if (colors) colors.push(color[0], color[1], color[2]);

            positions.push(p1[0] * c, p1[0] * s, p1[1]);
            normals.push(nr * c, nr * s, nz);
            if (colors) colors.push(color[0], color[1], color[2]);
        }

        const edgeBase = baseVertex + e * (segments + 1) * 2;

        for (let i = 0; i < segments; i++) {

            const k = edgeBase + i * 2;

            indices.push(k, k + 2, k + 3);
            indices.push(k, k + 3, k + 1);
        }
    }
}


function buildCoilGeometry(coils) {

    const THREE = window.THREE;

    const SEGMENTS = 40;   // 环向分段

    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];

    for (let g = 0; g < coils.length; g++) {

        const group = coils[g];

        let col = COIL_COLORS[group.name];

        if (!col) {
            col = (group.current > 0) ? [0.86, 0.62, 0.34] : [0.66, 0.50, 0.34];
        }

        for (let f = 0; f < group.filaments.length; f++) {

            const fil = group.filaments[f];

            // 真实绕组尺寸：径向 dR、竖直 dZ 的矩形导体
            const halfR = Math.max(fil[2] * 0.5, 0.0025);
            const halfZ = Math.max(fil[3] * 0.5, 0.0025);

            pushRingBox(positions, normals, colors, indices,
                        fil[0], fil[1], halfR, halfZ, SEGMENTS, col);
        }
    }

    const geo = new THREE.BufferGeometry();

    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    return geo;
}


// ============================================================
// 绝缘护套几何（矩形截面环形外壳，半透明）
//
// 真实 PF/TF 线圈是"多匝矩形导体 + 环氧浇注绝缘"：
//   - 导体匝：按 GSFit 给出的 dR × dZ 建矩形截面圆环；
//   - 绝缘层：每根导体外再包一层同构的薄壳，径向/竖直各外扩
//     INSULATION_MARGIN（默认 3.5 mm，像匝间绝缘/环氧包覆），
//     整层合成一个半透明材质、一次 draw call。
// ============================================================

const INSULATION_MARGIN = 0.0035;   // 护套超出导体表面的厚度 (m)

function buildInsulationGeometry(coils) {

    const THREE = window.THREE;

    const SEGMENTS = 32;

    const positions = [];
    const normals = [];
    const indices = [];

    for (let g = 0; g < coils.length; g++) {

        const group = coils[g];
        const filaments = group.filaments;

        if (!filaments || filaments.length === 0) continue;

        for (let f = 0; f < filaments.length; f++) {

            const fil = filaments[f];

            const halfR = Math.max(fil[2] * 0.5, 0.0025) + INSULATION_MARGIN;
            const halfZ = Math.max(fil[3] * 0.5, 0.0025) + INSULATION_MARGIN;

            pushRingBox(
                positions,
                normals,
                null,
                indices,
                fil[0],
                fil[1],
                halfR,
                halfZ,
                SEGMENTS
            );
        }
    }

    const geo = new THREE.BufferGeometry();

    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    return geo;
}


// ============================================================
// 由 [R, Z] 极向轮廓绕 Z 轴旋转成曲面（磁面 / 等离子体 / 真空室）
// ============================================================

function createLatheSurface(pointsRZ, color, emissive, opts) {

    const THREE = window.THREE;

    const profile = pointsRZ.map(function (p) {
        return new THREE.Vector2(p[0], p[1]);
    });

    const geo = new THREE.LatheGeometry(profile, 96);

    // LatheGeometry 绕 Y 轴旋转 -> 旋到 Z 轴
    geo.rotateX(Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: emissive || color,
        emissiveIntensity: (opts && opts.emissiveIntensity !== undefined)
            ? opts.emissiveIntensity : 0.3,
        transparent: true,
        opacity: (opts && opts.opacity !== undefined) ? opts.opacity : 0.2,
        roughness: 0.45,
        metalness: 0.25,
        side: (opts && opts.side) ? opts.side : THREE.FrontSide,
        depthWrite: false
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
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
//   centerR 环心的大半径位置，radius 环在 R-Z 平面内的半径
//   centerR = 0 时即以 Z 轴为中心的立环
// ============================================================

function createVerticalRing(centerR, radius, phi, tube, color) {

    const THREE = window.THREE;

    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);

    const points = [];
    const seg = 128;
    for (let i = 0; i <= seg; i++) {
        const t = 2 * Math.PI * i / seg;
        const rr = centerR + radius * Math.cos(t);
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

function disposeMesh(mesh) {

    if (!mesh) return;

    scene.remove(mesh);

    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
}


function removeSceneGeometry() {

    if (trajectoryLine) {
        disposeMesh(trajectoryLine);
        trajectoryLine = null;
    }

    if (fieldLineGroup) {
        scene.remove(fieldLineGroup);
        fieldLineGroup = null;
    }

    if (surfaceGroup) {
        scene.remove(surfaceGroup);
        surfaceGroup = null;
    }

    if (coilMesh) {
        disposeMesh(coilMesh);
        coilMesh = null;
    }

    if (insulationMesh) {
        disposeMesh(insulationMesh);
        insulationMesh = null;
    }

    if (vesselMesh) {
        disposeMesh(vesselMesh);
        vesselMesh = null;
    }

    if (plasmaMesh) {
        disposeMesh(plasmaMesh);
        plasmaMesh = null;
    }

    if (tfCoilGroup) {
        scene.remove(tfCoilGroup);
        tfCoilGroup = null;
    }

    if (axisRing) {
        disposeMesh(axisRing);
        axisRing = null;
    }

    if (columnMesh) {
        disposeMesh(columnMesh);
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

    const dist = 4.2 * Math.max(deviceOuter, deviceZmax);

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

    const modeSelect = document.getElementById("fieldMode");
    const mode = modeSelect ? modeSelect.value : "analytic";

    const params = {
        mode: mode,
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

    let data;
    try {
        data = window.runTokamakSimulation(params);
    } catch (e) {
        console.error(e);
        alert("模拟失败：\n" + e.message);
        return;
    }

    trajectoryPoints = data.positions;
    times = data.times;
    currentIndex = 0;
    isPlaying = false;

    buildSceneGeometry(data);

    trajectoryLine = createTrajectory(trajectoryPoints);
    scene.add(trajectoryLine);

    updateParticle(0);

    setCameraView(currentView);

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

    setText(
        "q-local",
        "q(磁轴)=" + data.q.toFixed(2) +
        " · q(r₀)=" + data.q_actual_launch.toFixed(3)
    );

    setText("cyc-period", formatScientific(data.cyclotron_period) + " s");
    setText("gyro-radius", formatScientific(data.gyro_radius) + " m");

    setText(
        "confinement",
        data.r_max_over_a.toFixed(4) +
        " (r₀/a=" + (data.r_surf / data.a).toFixed(3) + ")"
    );

    setText("energy-error", data.energy_error_percent.toFixed(4) + " %");

    setText(
        "steps-time",
        data.num_steps.toLocaleString() + " / " +
        formatScientific(data.total_time) + " s"
    );

    // 数据源说明
    if (data.mode === "gsfit" && data.gsfit) {
        setText(
            "source",
            "GSFit " + data.gsfit.machine + " #" + data.gsfit.pulse +
            " @ " + data.gsfit.timeMs + " ms"
        );
    } else {
        setText("source", "解析示意模型");
    }
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
// 磁场数据源切换
// ============================================================

function setupFieldMode() {

    const select = document.getElementById("fieldMode");
    const info = document.getElementById("gsfit-info");

    if (select) {
        select.addEventListener("change", applyFieldMode);
    }

    if (info && window.GSFIT_DATA) {
        const d = window.GSFIT_DATA;
        const eq = d.equilibrium;

        let legend = "";

        for (let i = 0; i < d.coils.length; i++) {
            const g = d.coils[i];
            const rgb = COIL_COLORS[g.name] || [0.6, 0.6, 0.6];
            const css = "rgb(" +
                Math.round(rgb[0] * 255) + "," +
                Math.round(rgb[1] * 255) + "," +
                Math.round(rgb[2] * 255) + ")";

            legend +=
                '<span class="coil-chip">' +
                '<i style="background:' + css + '"></i>' +
                g.name + " " + (g.current / 1000).toFixed(1) + "kA" +
                "</span>";
        }

        info.innerHTML =
            "<div>ST40 shot " + d.meta.pulse + " · t = " + d.meta.time_ms + " ms</div>" +
            "<div>磁轴 R = " + eq.axisR.toFixed(4) + " m，Z = " + eq.axisZ.toFixed(4) + " m</div>" +
            "<div>LCFS：R = " + eq.R0LCFS.toFixed(4) + " m，a = " + eq.aLCFS.toFixed(4) + " m</div>" +
            "<div>Ip = " + (eq.ip / 1000).toFixed(1) + " kA · " +
            d.coils.length + " 组 / " +
            d.coils.reduce((s, c) => s + c.n, 0) + " 根 filament</div>" +
            '<div class="coil-legend">' + legend + "</div>";
    }

    applyFieldMode();
}


// ============================================================
// 显示开关（绝缘护套显示 / 隐藏）
// ============================================================

function setupDisplayToggles() {

    const cb = document.getElementById("toggleInsulation");

    if (!cb) return;

    cb.checked = showInsulation;

    cb.addEventListener("change", function () {

        showInsulation = cb.checked;

        if (insulationMesh) {
            insulationMesh.visible = showInsulation;
        }

        console.log("绝缘护套：" + (showInsulation ? "显示" : "隐藏"));
    });
}


function applyFieldMode() {

    const select = document.getElementById("fieldMode");
    const mode = select ? select.value : "analytic";

    const R0Input = document.getElementById("R0");
    const aInput = document.getElementById("a");
    const B0Input = document.getElementById("B0");
    const qInput = document.getElementById("q");

    if (!R0Input) return;

    if (mode === "gsfit" && window.GSFIT_DATA) {

        const d = window.GSFIT_DATA;
        const eq = d.equilibrium;

        R0Input.value = eq.axisR.toFixed(4);
        aInput.value = eq.aLCFS.toFixed(4);
        B0Input.value = (d.tf.R0Bphi0 / eq.axisR).toFixed(4);
        qInput.value = "1.0";

        R0Input.disabled = true;
        aInput.disabled = true;
        B0Input.disabled = true;
        qInput.disabled = true;

    } else {

        R0Input.value = "2.0";
        aInput.value = "0.6";
        B0Input.value = "0.05";
        qInput.value = "3.0";

        R0Input.disabled = false;
        aInput.disabled = false;
        B0Input.disabled = false;
        qInput.disabled = false;
    }

    // r0 上限随小半径变化
    const rSurfInput = document.getElementById("rSurf");
    if (rSurfInput) {
        const aNow = parseFloat(aInput.value);
        rSurfInput.max = (aNow * 0.95).toFixed(4);
        if (parseFloat(rSurfInput.value) >= aNow) {
            rSurfInput.value = (aNow * 0.5).toFixed(4);
        }
    }
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
