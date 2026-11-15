// ============================================================
// Tokamak Particle Simulation — 纯前端物理引擎
//
// 本文件在浏览器本地完成全部物理计算，不依赖任何后端。
//
// 两种磁场模式（params.mode）：
//
//   1) "gsfit"    GSFit 重建的真实磁场（ST40 shot 12050 @130 ms）
//        环向场 B_phi(R) = R0_TF * B_phi0 / R
//        极向场 B_R = -(1/(2πR)) dpsi/dZ,  B_Z = +(1/(2πR)) dpsi/dR
//        psi 是 GSFit 逆平衡重建得到的总极向磁通（含线圈+等离子体）
//        psi 网格外用 PF 线圈（364 根 filament）毕奥-萨伐尔补
//
//   2) "analytic" 旧的解析示意模型
//        B_phi = B0*R0/R,  B_theta = Bp0*r/a
//
// 坐标：圆柱 (R, phi, Z)，R = sqrt(x²+y²)，磁轴在 (axisR, axisZ)。
// 粒子：洛伦兹力 a = (q/m)(v × B)，四阶 Runge-Kutta。
//
// 用法：
//   runTokamakSimulation(params) -> { positions, times, field_lines, ... }
// ============================================================

var MU0 = 4 * Math.PI * 1e-7;

// 当前磁场模式（由 runTokamakSimulation 设置）
var activeMode = "analytic";


// ============================================================
// GSFit 磁场模块的取用（浏览器 window.GSFitField / Node globalThis）
// ============================================================

function getGSFitField() {

    var root = (typeof globalThis !== "undefined") ? globalThis : null;

    if (root && root.GSFitField && root.GSFitField.isLoaded && root.GSFitField.isLoaded()) {
        return root.GSFitField;
    }

    return null;
}


// ============================================================
// 圆柱坐标 <-> 笛卡尔坐标
// ============================================================

function cylindricalFromCartesian(x, y, z) {

    var R = Math.sqrt(x * x + y * y);
    var phi = Math.atan2(y, x);
    return { R: R, phi: phi, Z: z };
}


// ============================================================
// 托卡马克磁场（笛卡尔分量）
//
// gsfit 模式：直接取 GSFitField
// analytic 模式：解析 TF + 线性极向场
// ============================================================

function tokamakField(x, y, z, R0, a, B0, qFactor) {

    var GF = getGSFitField();

    if (activeMode === "gsfit" && GF) {
        return GF.field(x, y, z);
    }

    var cy = cylindricalFromCartesian(x, y, z);
    var R = cy.R;
    var phi = cy.phi;
    var Z = cy.Z;

    // 极小半径（离磁轴距离），磁轴在 (R0, 0)
    var dR = R - R0;
    var r = Math.sqrt(dR * dR + Z * Z);

    // 环向场
    var Bphi = B0 * R0 / R;

    // 极向场（在等离子体边缘 Bp0，线性增长）
    var Bp0 = (a / R0) * B0 / qFactor;
    var Btheta = Bp0 * (r / a);

    // 极向单位方向（在 R-Z 平面内绕磁轴）：theta_hat = phi_hat × r_hat
    var thetaR;
    var thetaZ;

    if (r < 1e-12) {
        thetaR = 0;
        thetaZ = 0;
    } else {
        thetaR = Z / r;
        thetaZ = -(R - R0) / r;
    }

    var BR = Btheta * thetaR;
    var BZ = Btheta * thetaZ;

    var cosP = Math.cos(phi);
    var sinP = Math.sin(phi);

    var Bx = BR * cosP - Bphi * sinP;
    var By = BR * sinP + Bphi * cosP;
    var Bz = BZ;

    return [Bx, By, Bz];
}


// ============================================================
// 洛伦兹加速度
// ============================================================

function acceleration(
    position,
    velocity,
    charge,
    mass,
    R0,
    a,
    B0,
    qFactor
) {

    var B = tokamakField(
        position[0],
        position[1],
        position[2],
        R0,
        a,
        B0,
        qFactor
    );

    var qm = charge / mass;

    var ax = qm * (velocity[1] * B[2] - velocity[2] * B[1]);
    var ay = qm * (velocity[2] * B[0] - velocity[0] * B[2]);
    var az = qm * (velocity[0] * B[1] - velocity[1] * B[0]);

    return [ax, ay, az];
}


// ============================================================
// 磁场归一化方向（用于磁场线追踪）
// ============================================================

function tokamakFieldUnit(x, y, z, R0, a, B0, qFactor) {

    var B = tokamakField(x, y, z, R0, a, B0, qFactor);

    var mag = Math.sqrt(
        B[0] * B[0] + B[1] * B[1] + B[2] * B[2]
    );

    if (mag < 1e-20) {
        return [0, 0, 0];
    }

    return [B[0] / mag, B[1] / mag, B[2] / mag];
}


// ============================================================
// RK4 单步
//   state = [x, y, z, vx, vy, vz]
// ============================================================

function rk4Step(
    state,
    dt,
    charge,
    mass,
    R0,
    a,
    B0,
    qFactor
) {

    function derivative(s) {

        var position = [s[0], s[1], s[2]];
        var velocity = [s[3], s[4], s[5]];

        var acc = acceleration(
            position,
            velocity,
            charge,
            mass,
            R0,
            a,
            B0,
            qFactor
        );

        return [
            velocity[0],
            velocity[1],
            velocity[2],
            acc[0],
            acc[1],
            acc[2]
        ];
    }

    var k1 = derivative(state);
    var k2 = derivative([
        state[0] + 0.5 * dt * k1[0],
        state[1] + 0.5 * dt * k1[1],
        state[2] + 0.5 * dt * k1[2],
        state[3] + 0.5 * dt * k1[3],
        state[4] + 0.5 * dt * k1[4],
        state[5] + 0.5 * dt * k1[5]
    ]);
    var k3 = derivative([
        state[0] + 0.5 * dt * k2[0],
        state[1] + 0.5 * dt * k2[1],
        state[2] + 0.5 * dt * k2[2],
        state[3] + 0.5 * dt * k2[3],
        state[4] + 0.5 * dt * k2[4],
        state[5] + 0.5 * dt * k2[5]
    ]);
    var k4 = derivative([
        state[0] + dt * k3[0],
        state[1] + dt * k3[1],
        state[2] + dt * k3[2],
        state[3] + dt * k3[3],
        state[4] + dt * k3[4],
        state[5] + dt * k3[5]
    ]);

    var newState = [
        state[0] + dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
        state[1] + dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
        state[2] + dt / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
        state[3] + dt / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]),
        state[4] + dt / 6 * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]),
        state[5] + dt / 6 * (k1[5] + 2 * k2[5] + 2 * k3[5] + k4[5])
    ];

    return newState;
}


// ============================================================
// 在发射点把 (vPar, vPerp) 构造成三维速度
//   平行分量沿局部磁场 B_hat
//   垂直分量取 e_Z 在垂直 B 平面上的投影
// ============================================================

function buildInitialVelocity(
    R0, a, B0, qFactor,
    rSurf, vPar, vPerp, axisZ
) {

    var zStart = axisZ || 0;

    var px = R0 + rSurf;
    var py = 0;
    var pz = zStart;

    var B = tokamakField(px, py, pz, R0, a, B0, qFactor);
    var bMag = Math.sqrt(B[0] * B[0] + B[1] * B[1] + B[2] * B[2]);

    if (!(bMag > 0)) {
        throw new Error("发射点磁场为零，无法构造初速度。");
    }

    var bx = B[0] / bMag;
    var by = B[1] / bMag;
    var bz = B[2] / bMag;

    // 垂直试探方向 e_Z
    var ex = 0;
    var ey = 0;
    var ez = 1;

    var dot = bx * ex + by * ey + bz * ez;

    ex -= dot * bx;
    ey -= dot * by;
    ez -= dot * bz;

    var eMag = Math.sqrt(ex * ex + ey * ey + ez * ez);

    if (eMag < 1e-6) {
        // 磁场几乎竖直：换 e_R
        ex = 1;
        ey = 0;
        ez = 0;
        dot = bx;
        ex -= dot * bx;
        ey -= dot * by;
        ez -= dot * bz;
        eMag = Math.sqrt(ex * ex + ey * ey + ez * ez);
    }

    ex /= eMag;
    ey /= eMag;
    ez /= eMag;

    return {
        velocity: [
            vPar * bx + vPerp * ex,
            vPar * by + vPerp * ey,
            vPar * bz + vPerp * ez
        ],
        position: [px, py, pz],
        bMag: bMag
    };
}


// ============================================================
// 追踪磁力线（可视化）
// ============================================================

function traceFieldLines(
    R0, a, B0, qFactor,
    rSurf, fieldTurns, numLines
) {

    var lines = [];

    // ---------- gsfit：沿真实磁场积分 ----------
    var GF = getGSFitField();

    if (activeMode === "gsfit" && GF) {

        var stepSize = 0.004;
        var maxSteps = Math.max(
            200,
            Math.round(2 * Math.PI * R0 * fieldTurns / stepSize)
        );

        for (var li = 0; li < numLines; li++) {

            var phi0 = 2 * Math.PI * li / numLines;
            var Rl = R0 + rSurf;

            var start = [
                Rl * Math.cos(phi0),
                Rl * Math.sin(phi0),
                0
            ];

            lines.push(GF.traceLine(start, stepSize, maxSteps));
        }

        return lines;
    }

    // ---------- analytic：沿解析场积分 ----------
    var circumference = 2 * Math.PI * R0;

    var pointsPerTurn = 240;
    var totalPoints = Math.max(
        60,
        Math.round(pointsPerTurn * fieldTurns)
    );

    var ds = circumference / pointsPerTurn;

    for (var lj = 0; lj < numLines; lj++) {

        var phiStart = 2 * Math.PI * lj / numLines;

        var px = (R0 + rSurf) * Math.cos(phiStart);
        var py = (R0 + rSurf) * Math.sin(phiStart);
        var pz = 0;

        var pts = [[px, py, pz]];

        for (var i = 0; i < totalPoints; i++) {

            var dir = tokamakFieldUnit(px, py, pz, R0, a, B0, qFactor);

            px += dir[0] * ds;
            py += dir[1] * ds;
            pz += dir[2] * ds;

            pts.push([px, py, pz]);
        }

        lines.push(pts);
    }

    return lines;
}


// ============================================================
// 主模拟函数
// ============================================================

function runTokamakSimulation(params) {

    // --------------------------------------------------------
    // 模式
    // --------------------------------------------------------

    activeMode = (params["mode"] === "gsfit") ? "gsfit" : "analytic";

    var GF = (activeMode === "gsfit") ? getGSFitField() : null;

    if (activeMode === "gsfit" && !GF) {
        throw new Error(
            "GSFit 数据未加载：请确认 gsfit_data.js 与 gsfit_field.js 已引入。"
        );
    }

    // --------------------------------------------------------
    // 装置几何
    // --------------------------------------------------------

    var gsfitInfo = null;
    var axisZ = 0;

    if (GF) {

        var gd = GF.getData();
        var eq = gd.equilibrium;

        gsfitInfo = {
            machine: gd.meta.machine,
            pulse: gd.meta.pulse,
            timeMs: gd.meta.time_ms,
            axisR: eq.axisR,
            axisZ: eq.axisZ,
            aLCFS: eq.aLCFS,
            ip: eq.ip,
            filaments: gd.coils.reduce(function (s, c) { return s + c.n; }, 0),
            groups: gd.coils.length
        };

        axisZ = eq.axisZ;
    }

    var R0 = Number(params["R0"]);
    var a = Number(params["a"]);
    var B0 = Number(params["B0"]);
    var qFactor = Number(params["q"]);

    if (GF) {
        // GSFit 模式下几何由数据决定，输入框仅作显示
        R0 = gsfitInfo.axisR;
        a = gsfitInfo.aLCFS;
        B0 = GF.bToroidal(R0);   // 磁轴处环向场
        qFactor = Number(params["q"]) > 0 ? Number(params["q"]) : 1.0;
    }

    var charge = Number(params["qCharge"]);
    var mass = Number(params["m"]);

    var rSurf = Number(params["rSurf"]);
    var vPar = Number(params["vPar"]);
    var vPerp = Number(params["vPerp"]);

    var toroidalTurns = Number(params["toroidalTurns"]);
    var stepsPerGyro = Number(params["stepsPerGyro"]);

    // --------------------------------------------------------
    // 校验
    // --------------------------------------------------------

    if (!(R0 > 0)) throw new Error("大半径 R0 必须大于 0。");
    if (!(a > 0)) throw new Error("小半径 a 必须大于 0。");
    if (!(B0 > 0)) throw new Error("环向磁场 B0 必须大于 0。");
    if (!(mass > 0)) throw new Error("质量 m 必须大于 0。");
    if (charge === 0) throw new Error("电荷 q 不能为 0。");

    if (!(rSurf >= 0)) throw new Error("初始小半径 r0 不能为负。");
    if (rSurf >= a) throw new Error("初始小半径 r0 必须在真空室（r0 < a）内。");

    var speed = Math.sqrt(vPar * vPar + vPerp * vPerp);
    if (!(speed > 0)) throw new Error("初始速度不能为 0。");

    if (!(toroidalTurns > 0)) throw new Error("环向圈数必须大于 0。");
    if (stepsPerGyro < 20) throw new Error("每回旋周期步数应至少为 20。");

    // --------------------------------------------------------
    // 初始速度
    // --------------------------------------------------------

    var init = buildInitialVelocity(
        R0, a, B0, qFactor,
        rSurf, vPar, vPerp, axisZ
    );

    var velocity0 = init.velocity;
    var B_launch = init.bMag;

    // --------------------------------------------------------
    // 回旋频率 / 周期
    // --------------------------------------------------------

    var omega = Math.abs(charge) * B_launch / mass;
    var cyclotronFrequency = omega / (2 * Math.PI);
    var cyclotronPeriod = 2 * Math.PI / omega;

    var dt = cyclotronPeriod / stepsPerGyro;

    // --------------------------------------------------------
    // 一个环向圈的时间
    // --------------------------------------------------------

    var B_unit = tokamakFieldUnit(
        init.position[0], init.position[1], init.position[2],
        R0, a, B0, qFactor
    );

    var bPhiFrac = Math.sqrt(
        B_unit[0] * B_unit[0] + B_unit[1] * B_unit[1]
    );

    var vPhi = speed * Math.max(bPhiFrac, 1e-9);
    var timePerTurn = 2 * Math.PI * R0 / vPhi;

    var totalTime = toroidalTurns * timePerTurn;
    var numSteps = Math.ceil(totalTime / dt);

    if (numSteps > 1000000) {
        throw new Error(
            "计算步数过大（" + numSteps.toFixed(0) + " 步）。请减小环向圈数、增大 vPar，或减小 B0 / q/m。"
        );
    }

    // --------------------------------------------------------
    // 时间积分
    // --------------------------------------------------------

    var state = [
        init.position[0], init.position[1], init.position[2],
        velocity0[0], velocity0[1], velocity0[2]
    ];

    var positions = new Array(numSteps + 1);
    var times = new Array(numSteps + 1);

    positions[0] = [state[0], state[1], state[2]];
    times[0] = 0;

    var initialEnergy = 0.5 * mass * speed * speed;
    var maxEnergyError = 0;

    var rMax = rSurf;
    var RMin = init.position[0];
    var RMax = init.position[0];

    for (var i = 0; i < numSteps; i++) {

        state = rk4Step(state, dt, charge, mass, R0, a, B0, qFactor);

        positions[i + 1] = [state[0], state[1], state[2]];
        times[i + 1] = times[i] + dt;

        var sp = Math.sqrt(
            state[3] * state[3] + state[4] * state[4] + state[5] * state[5]
        );
        var e = 0.5 * mass * sp * sp;
        var err = Math.abs(e - initialEnergy) / initialEnergy * 100;
        if (err > maxEnergyError) maxEnergyError = err;

        var R = Math.sqrt(state[0] * state[0] + state[1] * state[1]);
        var dz = state[2] - axisZ;
        var dr = Math.sqrt((R - R0) * (R - R0) + dz * dz);
        if (dr > rMax) rMax = dr;
        if (R < RMin) RMin = R;
        if (R > RMax) RMax = R;
    }

    // --------------------------------------------------------
    // 磁力线
    // --------------------------------------------------------

    var fieldLines = traceFieldLines(
        R0, a, B0, qFactor,
        rSurf, 1.6, 5
    );

    // --------------------------------------------------------
    // 发射点诊断量
    // --------------------------------------------------------

    var Bcyl = null;

    if (GF) {
        Bcyl = GF.fieldCylindrical(init.position[0], init.position[2]);
    }

    var B_poloidal_launch;
    var B_toroidal_launch;

    if (Bcyl) {
        B_toroidal_launch = Math.abs(Bcyl.Bphi);
        B_poloidal_launch = Math.sqrt(Bcyl.BR * Bcyl.BR + Bcyl.BZ * Bcyl.BZ);
    } else {
        B_poloidal_launch = (a / R0) * B0 / qFactor * (rSurf / a);
        B_toroidal_launch = B0 * R0 / (R0 + rSurf);
    }

    var pitchAngle = Math.atan2(B_poloidal_launch, B_toroidal_launch) * 180 / Math.PI;

    var q_actual = (rSurf * B_toroidal_launch)
        / ((R0 + rSurf) * Math.max(B_poloidal_launch, 1e-30));

    // --------------------------------------------------------
    // 返回结果
    // --------------------------------------------------------

    return {
        "mode": activeMode,
        "gsfit": gsfitInfo,
        "axisR": R0,
        "axisZ": axisZ,

        "positions": positions,
        "times": times,
        "field_lines": fieldLines,

        "R0": R0,
        "a": a,
        "B0": B0,
        "q": qFactor,

        "B_launch": B_launch,
        "B_toroidal_launch": B_toroidal_launch,
        "B_poloidal_launch": B_poloidal_launch,
        "pitch_angle_deg": pitchAngle,
        "q_actual_launch": q_actual,

        "cyclotron_frequency": cyclotronFrequency,
        "cyclotron_period": cyclotronPeriod,
        "dt": dt,
        "total_time": times[numSteps],
        "num_steps": numSteps,

        "gyro_radius": vPerp / omega,

        "energy_error_percent": maxEnergyError,

        "r_surf": rSurf,
        "r_max": rMax,
        "r_max_over_a": rMax / a,
        "R_min": RMin,
        "R_max": RMax
    };
}


// ============================================================
// Node 兼容（离线验证用）
// ============================================================

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        runTokamakSimulation: runTokamakSimulation,
        tokamakField: tokamakField,
        traceFieldLines: traceFieldLines,
        getGSFitField: getGSFitField
    };
}
