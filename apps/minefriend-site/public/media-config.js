/**
 * MineClaw 参赛页视频配置。
 *
 * 录制完成后把视频放入 media/videos/，再填写相对于当前页面的路径：
 *   src: './media/videos/overview.mp4'
 * 也可以填写确认可公开访问的 HTTPS URL。src 为空时页面显示拍摄占位卡，
 * 不会创建播放器，也不会发起空媒体请求。
 */
window.MINECLAW_SHOWCASE_MEDIA = {
  overview: {
    title: '一个伙伴，真正走进我的世界',
    src: '',
    poster: './media/ai-keyframes/02-meeting-end.png?v=20260827-2205',
  },
  recovery: {
    title: '我们一起度过 Minecraft 的一天',
    src: '',
    poster: './media/ai-keyframes/04-homecoming-end.png?v=20260827-2205',
  },
  memory: {
    title: '她不只听懂我，还能和我一起把事做成',
    src: '',
    poster: './media/ai-keyframes/03-departure-end.png?v=20260827-2205',
  },
};
