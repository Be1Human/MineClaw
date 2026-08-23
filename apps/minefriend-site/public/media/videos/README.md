# MineClaw 演示视频投放位

视频可以后补。录制完成后将文件放在本目录，并在发布包根目录的 `media-config.js` 中填写相对路径。

| 建议文件名 | 建议时长 | 演示主线 |
|---|---:|---|
| `overview.mp4` | 约 01:30 | 玩家上线 → MineClaw 的伙伴进入世界 → 自主来到身边 → 第一次面对面聊天 → 一起决定去哪 |
| `day-together.mp4` | 约 00:45 | 晨光里聊天 → 一起准备营地和物资 → 穿过森林 → 进入矿洞 → 夜色中一起回家 |
| `goal-together.mp4` | 约 00:45 | 玩家说出目标 → 伙伴理解与规划 → 采集、制作或整理 → 遇阻调整 → 世界结果与共同完成画面 |

推荐导出 H.264 编码的 MP4，兼顾主流桌面与移动浏览器。封面可继续使用 `media/images/` 中的实拍，也可以新增图片并在 `poster` 中填写相对路径。

示例：

```js
overview: {
  title: '一个伙伴，真正走进我的世界',
  src: './media/videos/overview.mp4',
  poster: './media/images/mineclaw-companion-in-world.png',
}
```
