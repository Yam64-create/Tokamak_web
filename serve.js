// ============================================================
// 零依赖静态服务器（仅供本地预览）
//
//   node serve.js           默认端口 8081
//   node serve.js 9000      指定端口
//
// 只用于绕过浏览器对 file:// 下 ES Module 的 CORS 限制，
// 与部署到 GitHub Pages / Vercel 等静态托管等价。
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8081;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2"
};

const server = http.createServer(function (req, res) {

    let urlPath = decodeURIComponent(req.url.split("?")[0]);

    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(ROOT, urlPath);

    // 只允许访问项目目录内的文件
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("403 Forbidden");
        return;
    }

    fs.readFile(filePath, function (err, data) {

        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("404 Not Found: " + urlPath);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();

        res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Cache-Control": "no-cache"
        });
        res.end(data);
    });
});

server.listen(PORT, function () {
    console.log("Tokamak web running at http://localhost:" + PORT + "/");
});
