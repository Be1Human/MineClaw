# MineClaw 参赛介绍页 · 部署说明

这个文件夹就是完整的静态网页发布包，不需要 Node.js、后端、数据库或 Minecraft 服务器。

## 部署

1. 将 `mineclaw-showcase/` 文件夹内的全部内容上传到任意静态网站服务。
2. 可以直接部署到域名根目录，也可以部署到 `/mineclaw-showcase/` 等子目录。
3. 服务器只需按原目录结构提供静态文件；不需要 rewrite 或代理规则。

请不要只上传 `index.html`。`assets/`、`media/`、`media-config.js` 都是页面的一部分。

## 补充视频

1. 把录制好的 MP4 或 WebM 放入 `media/videos/`。
2. 打开发布包根目录的 `media-config.js`。
3. 将对应条目的 `src` 改为相对路径，例如：

```js
src: './media/videos/overview.mp4'
```

页面会把原来的“待录制”卡片自动替换为播放器，不需要重新修改 HTML、CSS 或 JavaScript。

建议文件名与镜头要求见 `media/videos/README.md`。

## 本地预览

不能通过双击 `index.html` 验收 ES Module 页面。请在本目录启动任意静态文件服务器，例如：

```bash
python3 -m http.server 8080
```

然后访问 `http://127.0.0.1:8080/`。
