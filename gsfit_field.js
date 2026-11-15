// ============================================================
// GSFit 磁场模块（浏览器 + Node 通用）
//
// 数据来源：window.GSFIT_DATA（由 export_web_gsfit_data.py 生成）
//
//   TF：B_phi(R) = R0 * B_phi0 / R
//
//   极向场：来自重建的总极向磁通 psi(R,Z)
//       B_R = -(1/(2πR)) dpsi/dZ
//       B_Z = +(1/(2πR)) dpsi/dR
//   psi 用 Catmull-Rom 双三次插值（值和导数都连续，避免洛伦兹力
//   在网格边界跳变导致能量不守恒）。
//   psi 网格外：退回 PF 线圈毕奥-萨伐尔（椭圆积分闭式解）。
//
// 注意：psi 是总磁通（线圈+等离子体+被动结构），所以 psi 与线圈场
// 不能相加，只能二选一：网格内用 psi，网格外用线圈。
// ============================================================

(function (root, factory) {

    var api = factory();

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.GSFitField = api;
    }

})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    var MU0 = 4 * Math.PI * 1e-7;

    var data = null;
    var psiValues = null;

    var state = {
        loaded: false,
        source: "psi"        // "psi" | "coils"
    };


    // --------------------------------------------------------
    // 椭圆积分 K(m), E(m)，m = k^2，AGM 算法
    // --------------------------------------------------------

    function ellipKE(m) {

        var a = 1.0;
        var b = Math.sqrt(Math.max(1.0 - m, 0.0));
        var c = Math.sqrt(Math.max(m, 0.0));

        var sum = 0.5 * c * c;
        var w = 1.0;

        for (var n = 0; n < 10; n++) {

            var an = 0.5 * (a + b);
            var bn = Math.sqrt(a * b);

            c = 0.5 * (a - b);

            a = an;
            b = bn;

            sum += w * c * c;
            w *= 2.0;
        }

        var K = Math.PI / (2.0 * a);
        var E = K * (1.0 - sum);

        return [K, E];
    }


    // --------------------------------------------------------
    // 初始化
    // --------------------------------------------------------

    function init(gsfitData) {

        data = gsfitData;

        if (!data || !data.psi) {
            throw new Error("GSFitField: 缺少 GSFIT_DATA / psi 数据");
        }

        psiValues = data.psi.values.map(Number);

        state.loaded = true;

        return true;
    }


    // --------------------------------------------------------
    // 网格范围
    // --------------------------------------------------------

    function rMin() { return data.psi.r_min; }
    function zMin() { return data.psi.z_min; }
    function rMax() { return data.psi.r_min + (data.psi.n_r - 1) * data.psi.d_r; }
    function zMax() { return data.psi.z_min + (data.psi.n_z - 1) * data.psi.d_z; }

    function insideGrid(R, Z) {
        return R >= rMin() && R <= rMax() && Z >= zMin() && Z <= zMax();
    }


    // --------------------------------------------------------
    // Catmull-Rom 权重及其导数
    // --------------------------------------------------------

    function crWeights(t, outW, outD) {

        var t2 = t * t;
        var t3 = t2 * t;

        outW[0] = -0.5 * t3 + t2 - 0.5 * t;
        outW[1] = 1.5 * t3 - 2.5 * t2 + 1.0;
        outW[2] = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
        outW[3] = 0.5 * t3 - 0.5 * t2;

        outD[0] = -1.5 * t2 + 2.0 * t - 0.5;
        outD[1] = 4.5 * t2 - 5.0 * t;
        outD[2] = -4.5 * t2 + 4.0 * t + 0.5;
        outD[3] = 1.5 * t2 - t;
    }

    var wxTmp = new Array(4);
    var wzTmp = new Array(4);
    var dwxTmp = new Array(4);
    var dwzTmp = new Array(4);


    // --------------------------------------------------------
    // psi 双三次插值：返回 { value, dR, dZ }
    // --------------------------------------------------------

    function samplePsi(R, Z) {

        var psi = data.psi;
        var nr = psi.n_r;
        var nz = psi.n_z;

        var fi = (R - psi.r_min) / psi.d_r;
        var fj = (Z - psi.z_min) / psi.d_z;

        if (fi < 0) fi = 0;
        if (fj < 0) fj = 0;
        if (fi > nr - 1.000001) fi = nr - 1.000001;
        if (fj > nz - 1.000001) fj = nz - 1.000001;

        var i0 = Math.floor(fi);
        var j0 = Math.floor(fj);

        var u = fi - i0;
        var v = fj - j0;

        crWeights(u, wxTmp, dwxTmp);
        crWeights(v, wzTmp, dwzTmp);

        var value = 0.0;
        var dR = 0.0;
        var dZ = 0.0;

        for (var b = 0; b < 4; b++) {

            var jj = j0 + b - 1;
            if (jj < 0) jj = 0;
            if (jj > nz - 1) jj = nz - 1;

            var rowOff = jj * nr;

            for (var a = 0; a < 4; a++) {

                var ii = i0 + a - 1;
                if (ii < 0) ii = 0;
                if (ii > nr - 1) ii = nr - 1;

                var p = psiValues[rowOff + ii];

                value += wxTmp[a] * wzTmp[b] * p;
                dR += dwxTmp[a] * wzTmp[b] * p;
                dZ += wxTmp[a] * dwzTmp[b] * p;
            }
        }

        return {
            value: value,
            dR: dR / psi.d_r,
            dZ: dZ / psi.d_z
        };
    }


    // --------------------------------------------------------
    // 物理量
    // --------------------------------------------------------

    function bToroidal(R) {
        return data.tf.R0Bphi0 / R;
    }

    // 极向场：直接用 psi 梯度（网格内）
    function bPoloidalPsi(R, Z) {

        var s = samplePsi(R, Z);

        var scale = 1.0 / (2.0 * Math.PI * R);

        return [
            -s.dZ * scale,     // B_R
            s.dR * scale       // B_Z
        ];
    }

    // 极向场：PF 线圈毕奥-萨伐尔（网格外使用）
    function bPoloidalCoils(R, Z) {

        var coils = data.coils;

        if (R < 1e-3) {

            var bzAxis = 0.0;

            for (var c0 = 0; c0 < coils.length; c0++) {
                var fil0 = coils[c0].filaments;
                var cur0 = coils[c0].current;
                for (var k0 = 0; k0 < fil0.length; k0++) {
                    var a0 = fil0[k0][0];
                    var z0 = Z - fil0[k0][1];
                    bzAxis += MU0 * cur0 * a0 * a0
                        / (2.0 * Math.pow(a0 * a0 + z0 * z0, 1.5));
                }
            }

            return [0.0, bzAxis];
        }

        var br = 0.0;
        var bz = 0.0;

        for (var c = 0; c < coils.length; c++) {

            var fil = coils[c].filaments;
            var cur = coils[c].current;

            if (cur === 0.0) continue;

            var pre = MU0 * cur / (2.0 * Math.PI);

            for (var k = 0; k < fil.length; k++) {

                var a = fil[k][0];
                var zc = Z - fil[k][1];

                var alpha2 = (a - R) * (a - R) + zc * zc;
                if (alpha2 < 1e-12) alpha2 = 1e-12;

                var beta = Math.sqrt(a * a + R * R + zc * zc + 2.0 * a * R);

                var m = 4.0 * a * R / (beta * beta);
                if (m > 1.0 - 1e-12) m = 1.0 - 1e-12;
                if (m < 0.0) m = 0.0;

                var ke = ellipKE(m);
                var K = ke[0];
                var E = ke[1];

                br += pre * zc / (R * beta)
                    * (-K + (a * a + R * R + zc * zc) / alpha2 * E);

                bz += pre / beta
                    * (K + (a * a - R * R - zc * zc) / alpha2 * E);
            }
        }

        return [br, bz];
    }


    function poloidal(R, Z) {

        if (state.source === "coils") {
            return bPoloidalCoils(R, Z);
        }

        if (insideGrid(R, Z)) {
            return bPoloidalPsi(R, Z);
        }

        return bPoloidalCoils(R, Z);
    }


    // --------------------------------------------------------
    // 总磁场（笛卡尔）
    // --------------------------------------------------------

    function field(x, y, z) {

        if (!state.loaded) {
            throw new Error("GSFitField: 未初始化，先调用 init(GSFIT_DATA)");
        }

        var R = Math.sqrt(x * x + y * y);
        var Ruse = Math.max(R, 1e-6);

        var bp = poloidal(Ruse, z);

        var BR = bp[0];
        var BZ = bp[1];
        var Bphi = bToroidal(Ruse);

        var cosP = x / Ruse;
        var sinP = y / Ruse;

        return [
            BR * cosP - Bphi * sinP,
            BR * sinP + Bphi * cosP,
            BZ
        ];
    }

    function fieldMag(x, y, z) {
        var B = field(x, y, z);
        return Math.sqrt(B[0] * B[0] + B[1] * B[1] + B[2] * B[2]);
    }

    function fieldUnit(x, y, z) {

        var B = field(x, y, z);
        var mag = Math.sqrt(B[0] * B[0] + B[1] * B[1] + B[2] * B[2]);

        if (mag < 1e-20) return [0, 0, 0];

        return [B[0] / mag, B[1] / mag, B[2] / mag];
    }

    // 圆柱坐标分量（诊断用）
    function fieldCylindrical(R, Z) {

        var bp = poloidal(R, Z);

        return {
            BR: bp[0],
            Bphi: bToroidal(R),
            BZ: bp[1]
        };
    }


    // --------------------------------------------------------
    // 磁力线追踪（沿 B 方向，二阶步进）
    // --------------------------------------------------------

    function traceLine(start, stepSize, maxSteps) {

        var pts = [[start[0], start[1], start[2]]];

        var px = start[0];
        var py = start[1];
        var pz = start[2];

        for (var i = 0; i < maxSteps; i++) {

            var d1 = fieldUnit(px, py, pz);

            if (d1[0] === 0 && d1[1] === 0 && d1[2] === 0) break;

            var mx = px + 0.5 * stepSize * d1[0];
            var my = py + 0.5 * stepSize * d1[1];
            var mz = pz + 0.5 * stepSize * d1[2];

            var d2 = fieldUnit(mx, my, mz);

            px += stepSize * d2[0];
            py += stepSize * d2[1];
            pz += stepSize * d2[2];

            pts.push([px, py, pz]);

            var R = Math.sqrt(px * px + py * py);
            if (R < 0.02 || Math.abs(pz) > 0.95) break;
        }

        return pts;
    }


    return {
        init: init,
        field: field,
        fieldUnit: fieldUnit,
        fieldMag: fieldMag,
        fieldCylindrical: fieldCylindrical,
        bToroidal: bToroidal,
        bPoloidalPsi: bPoloidalPsi,
        bPoloidalCoils: bPoloidalCoils,
        samplePsi: samplePsi,
        traceLine: traceLine,
        ellipKE: ellipKE,
        setSource: function (s) { state.source = s; },
        getSource: function () { return state.source; },
        isLoaded: function () { return state.loaded; },
        getData: function () { return data; }
    };
});
