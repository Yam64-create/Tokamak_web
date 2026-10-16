// ============================================================
// Tokamak Particle Simulation — 纯前端物理引擎
//
// 本文件在浏览器本地完成全部物理计算，不依赖任何后端。
//
// 磁场模型（托卡马克轴对称场）：
//   环向场 B_phi(R) = B0 * R0 / R          （1/R 衰减，环形场线圈产生）
//   极向场 B_theta(r)= Bp0 * r / a         （等离子体电流产生）
//        Bp0 = (a/R0) * B0 / q             （由安全因子 q 导出）
//   总磁场 B = B_phi * phi_hat + B_theta * theta_hat
//
// 坐标：圆柱坐标 (R, phi, Z)，R = sqrt(x^2+y^2)，磁轴在 (R0, 0)。
// 粒子运动：洛伦兹力 a = (q/m)(v × B)，四阶 Runge-Kutta 积分。
//
// 用法（浏览器）：
//   runTokamakSimulation(params)
//   返回 { success:true, data:{...} } 或 { success:false, error:"..." }
//
// 本文件是普通脚本（非 module），在浏览器中定义全局函数；
// 同时支持 Node require 以便离线验证。
// ============================================================

var MU0 = 4 * Math.PI * 1e-7;


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
// 输入点 (x,y,z)，输出 B = [Bx, By, Bz]
// ============================================================

function tokamakField(x, y, z, R0, a, B0, qFactor) {

    var cy = cylindricalFromCartesian(x, y, z);
    var R = cy.R;
    var phi = cy.phi;
    var Z = cy.Z;

    // 极小半径（离磁轴距离），磁轴在 (R0, Z=0)
    var dR = R - R0;
    var r = Math.sqrt(dR * dR + Z * Z);

    // 环向场
    var Bphi = B0 * R0 / R;

    // 极向场（在等离子体边缘 Bp0，线性增长）
    var Bp0 = (a / R0) * B0 / qFactor;
    var Btheta = Bp0 * (r / a);

    // 极向单位方向（在 R-Z 平面内绕磁轴）：theta_hat = phi_hat × r_hat
    //   在圆柱分量 (eR, ephi, eZ) 下：
    //     theta_R  =  Z / r
    //     theta_Z  = -(R - R0) / r
    var thetaR;
    var thetaZ;

    if (r < 1e-12) {
        thetaR = 0;
        thetaZ = 0;
    } else {
        thetaR = Z / r;
        thetaZ = -(R - R0) / r;
    }

    // 磁场圆柱分量
    var BR = Btheta * thetaR;
    var BZ = Btheta * thetaZ;

    // 转换到笛卡尔：
    //   eR = (cosφ, sinφ, 0)
    //   phi_hat = (-sinφ, cosφ, 0)
    //   eZ = (0, 0, 1)
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

    // a = (q/m)(v × B)
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
// 在初始位置处把 (vPar, vPerp) 构造成三维速度
//   平行分量沿局部磁场 B_hat
//   垂直分量沿极向切线方向（初始时上下竖直）
// ============================================================

function buildInitialVelocity(
    R0, a, B0, qFactor,
    rSurf, vPar, vPerp
) {

    // 发射点：外中平面 (R0 + rSurf, 0, 0)，phi = 0
    var px = R0 + rSurf;
    var py = 0;
    var pz = 0;

    var B = tokamakField(px, py, pz, R0, a, B0, qFactor);
    var bMag = Math.sqrt(B[0] * B[0] + B[1] * B[1] + B[2] * B[2]);

    var bx = B[0] / bMag;
    var by = B[1] / bMag;
    var bz = B[2] / bMag;

    // 极向切线方向（在发射点 = -eZ，即竖直向下）
    // 归一化，确保与 B_hat 正交
    var ex = 0;
    var ey = 0;
    var ez = -1;

    // 与 B_hat 正交化
    var dot = bx * ex + by * ey + bz * ez;
    ex -= dot * bx;
    ey -= dot * by;
    ez -= dot * ez;

    var eMag = Math.sqrt(ex * ex + ey * ey + ez * ez);

    if (eMag < 1e-12) {
        // 极端情况：磁场竖直，选一个任意垂直方向
        ex = 1; ey = 0; ez = 0;
        eMag = 1;
    }

    ex /= eMag;
    ey /= eMag;
    ez /= eMag;

    var vx = vPar * bx + vPerp * ex;
    var vy = vPar * by + vPerp * ey;
    var vz = vPar * bz + vPerp * ez;

    return {
        velocity: [vx, vy, vz],
        bMag: bMag,
        bx: bx, by: by, bz: bz,
        Bphi: B[1] / Math.max(bMag, 1e-30) * 0 // placeholder unused
    };
}


// ============================================================
// 追踪磁面上的磁场螺旋线（用于可视化）
//
// 返回若干条螺旋线，每条为 [[x,y,z], ...]，
// 沿磁场方向积分，覆盖 fieldTurns 个环向圈。
// ============================================================

function traceFieldLines(
    R0, a, B0, qFactor,
    rSurf, fieldTurns, numLines
) {

    var lines = [];

    // 磁面周长（一个环向圈的弧长 ≈ 2πR0）
    var circumference = 2 * Math.PI * R0;

    // 每圈采样点数
    var pointsPerTurn = 240;
    var totalPoints = Math.max(
        60,
        Math.round(pointsPerTurn * fieldTurns)
    );

    var ds = circumference / pointsPerTurn;

    for (var li = 0; li < numLines; li++) {

        // 起始环向角，让多条螺旋线在环向上错开
        var phi0 = 2 * Math.PI * li / numLines;

        var px = (R0 + rSurf) * Math.cos(phi0);
        var py = (R0 + rSurf) * Math.sin(phi0);
        var pz = 0;

        var pts = [[px, py, pz]];

        for (var i = 0; i < totalPoints; i++) {

            var dir = tokamakFieldUnit(
                px, py, pz,
                R0, a, B0, qFactor
            );

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
    // 读取参数
    // --------------------------------------------------------

    var R0       = Number(params["R0"]);
    var a        = Number(params["a"]);
    var B0       = Number(params["B0"]);
    var qFactor  = Number(params["q"]);

    var charge   = Number(params["qCharge"]);
    var mass     = Number(params["m"]);

    var rSurf    = Number(params["rSurf"]);
    var vPar     = Number(params["vPar"]);
    var vPerp    = Number(params["vPerp"]);

    var toroidalTurns = Number(params["toroidalTurns"]);
    var stepsPerGyro  = Number(params["stepsPerGyro"]);

    // --------------------------------------------------------
    // 校验
    // --------------------------------------------------------

    if (!(R0 > 0))          throw new Error("大半径 R0 必须大于 0。");
    if (!(a > 0))           throw new Error("小半径 a 必须大于 0。");
    if (!(B0 > 0))          throw new Error("环向磁场 B0 必须大于 0。");
    if (!(qFactor > 0))     throw new Error("安全因子 q 必须大于 0。");
    if (!(mass > 0))        throw new Error("质量 m 必须大于 0。");
    if (charge === 0)       throw new Error("电荷 q 不能为 0。");

    if (!(rSurf >= 0))      throw new Error("初始小半径 r0 不能为负。");
    if (rSurf >= a)         throw new Error("初始小半径 r0 必须在真空室（r0 < a）内。");

    var speed = Math.sqrt(vPar * vPar + vPerp * vPerp);
    if (!(speed > 0))       throw new Error("初始速度不能为 0（vPar 与 vPerp 至少一个非零）。");

    if (!(toroidalTurns > 0)) throw new Error("环向圈数必须大于 0。");
    if (stepsPerGyro < 20)    throw new Error("每回旋周期步数应至少为 20。");

    // --------------------------------------------------------
    // 初始速度
    // --------------------------------------------------------

    var init = buildInitialVelocity(
        R0, a, B0, qFactor,
        rSurf, vPar, vPerp
    );

    var velocity0 = init.velocity;
    var B_launch = init.bMag;

    // --------------------------------------------------------
    // 回旋频率 / 周期
    // --------------------------------------------------------

    var omega = Math.abs(charge) * B_launch / mass;
    var cyclotronFrequency = omega / (2 * Math.PI);
    var cyclotronPeriod = 2 * Math.PI / omega;

    // --------------------------------------------------------
    // 时间步长
    // --------------------------------------------------------

    var dt = cyclotronPeriod / stepsPerGyro;

    // 一个环向圈所需时间（沿磁场方向的环向分速度）
    //   v_phi = v * (B_phi / |B|)，在发射点近似
    var B0_unit = tokamakFieldUnit(
        R0 + rSurf, 0, 0,
        R0, a, B0, qFactor
    );
    var bPhiFrac = Math.sqrt(
        B0_unit[0] * B0_unit[0] + B0_unit[1] * B0_unit[1]
    );

    var vPhi = speed * Math.max(bPhiFrac, 1e-9);
    var timePerTurn = 2 * Math.PI * R0 / vPhi;

    var totalTime = toroidalTurns * timePerTurn;

    var numSteps = Math.ceil(totalTime / dt);

    // --------------------------------------------------------
    // 步数上限保护（避免浏览器卡死）
    // --------------------------------------------------------

    if (numSteps > 1000000) {
        throw new Error(
            "计算步数过大（" + numSteps.toFixed(0) + " 步）。请减小环向圈数、增大 vPar，或减小 B0 / q/m。"
        );
    }

    // --------------------------------------------------------
    // 初始状态
    // --------------------------------------------------------

    var state = [
        R0 + rSurf, 0, 0,
        velocity0[0], velocity0[1], velocity0[2]
    ];

    var positions = new Array(numSteps + 1);
    var times = new Array(numSteps + 1);

    positions[0] = [state[0], state[1], state[2]];
    times[0] = 0;

    var initialEnergy = 0.5 * mass * speed * speed;
    var maxEnergyError = 0;

    var rMax = rSurf;
    var RMin = R0 + rSurf;
    var RMax = R0 + rSurf;

    // --------------------------------------------------------
    // 时间积分
    // --------------------------------------------------------

    for (var i = 0; i < numSteps; i++) {

        state = rk4Step(
            state, dt,
            charge, mass,
            R0, a, B0, qFactor
        );

        positions[i + 1] = [state[0], state[1], state[2]];
        times[i + 1] = times[i] + dt;

        // 能量
        var sp = Math.sqrt(
            state[3] * state[3] + state[4] * state[4] + state[5] * state[5]
        );
        var e = 0.5 * mass * sp * sp;
        var err = Math.abs(e - initialEnergy) / initialEnergy * 100;
        if (err > maxEnergyError) maxEnergyError = err;

        // 约束诊断：最大离轴距离、R 范围
        var R = Math.sqrt(state[0] * state[0] + state[1] * state[1]);
        var dr = Math.sqrt((R - R0) * (R - R0) + state[2] * state[2]);
        if (dr > rMax) rMax = dr;
        if (R < RMin) RMin = R;
        if (R > RMax) RMax = R;
    }

    // --------------------------------------------------------
    // 磁场螺旋线（可视化）
    // --------------------------------------------------------

    var fieldLines = traceFieldLines(
        R0, a, B0, qFactor,
        rSurf, 1.6, 5
    );

    // --------------------------------------------------------
    // 发射点物理量
    // --------------------------------------------------------

    var B_poloidal_launch = (a / R0) * B0 / qFactor * (rSurf / a);
    var B_toroidal_launch = B0 * R0 / (R0 + rSurf);
    var pitchAngle = Math.atan2(B_poloidal_launch, B_toroidal_launch) * 180 / Math.PI;

    // 发射点实际安全因子
    var q_actual = (rSurf * B_toroidal_launch) / ((R0 + rSurf) * B_poloidal_launch);

    // --------------------------------------------------------
    // 返回结果
    // --------------------------------------------------------

    return {
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
        traceFieldLines: traceFieldLines
    };
}
