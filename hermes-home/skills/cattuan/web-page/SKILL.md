---
name: web-page
description: "做网页：把查到的信息做成一个能直接看的单页网站（导游图、攻略页、对比表、清单、行程、H5 小页面），用 publish_site 发布到 App 里。用户要「网站 / 网页 / 可视化 / 导游图 / 攻略页」时用。"
version: 0.1.0
author: CatTuan
license: MIT
metadata:
  hermes:
    tags: [网页, 网站, 可视化, 导游图, 攻略]
---

# 做网页

## 步骤
1. **先把内容备齐**：网页里的事实（名称、地址、价格、营业时间、路线）都要来自这次查到的真实来源；还没查就先用 deep_web_search / read_webpage / xiaohongshu_search 查。查不到的写「待确认」，不要编。
   - xiaohongshu_search 关键词策略：短词/常见词（如「送女朋友礼物」「生日礼物」）经常返回空结果；用更长的组合词（如「北京 礼物 女朋友」「情侣礼物 纪念日」「生日礼物 闺蜜 女友」）或加地名/场景词命中率更高。一次搜不到就换 2-3 个不同角度的长关键词，别放弃。
2. **写成单文件网页**：一个完整的 HTML（`<!DOCTYPE html>` 开头），CSS 和 JS 都写在文件里。
3. **发布**：`publish_site(title, html, description)`。用户要改已有网站时：`read_site(site_id)` → 在原 HTML 上改 → `publish_site(site_id=同一个 id, ...)`。
4. **自查（每次发布后都做）**：`check_site(site_id)` 在沙箱浏览器里真的打开网页。有交互的（游戏、测验、筛选、展开）带上 `click`，按用户会点的顺序点一遍，例如 `click=["开始挑战", ".option-btn"]`。`issues` 里有 `pageerror` / `error` / `requestfailed`，或者某次点击 `ok: false`，就改好重新发布、再查一次，直到没有报错再回复。
5. **回复**：两三句说网站里有什么（几个地点、几条路线、亮点），不贴代码，不说附件、下载、用浏览器打开——App 会自动在消息下面放网站卡片。

## 用户说打不开 / 点不动 / 有 bug
1. **先看真实报错**：`check_site(site_id, click=[用户说点不动的那几步])`。不要只读源码猜，也不要换一种写法整页重写——不看报错乱改，改几版都还是坏的。
2. **按 issues 定位**（`where` 是 index.html 的行号，`code` 是那一行代码）：
   - `SyntaxError`：整段 `<script>` 一行都没执行，所以所有按钮都没反应。最常见的是字符串里有没转义的引号，例如 `"B. 直接问"你是不是不想理我"",` 要写成 `'B. 直接问"你是不是不想理我"',`。
   - `ReferenceError: xxx is not defined`：往往是前面的 SyntaxError 让函数没定义上，先修语法错误；不是的话就是变量名拼错或用在定义之前。
   - `requestfailed` / `blocked`：外部资源没加载上（CDN 地址或版本号写错、用了 http、想访问本机）。
   - 点击 `ok: false`：`coveredBy` 是挡住按钮的元素（透明遮罩、没关掉的弹层），`元素不可见` 是按钮还藏着。
3. **只改出错的地方**：`read_site` → 改那几行 → `publish_site(site_id=同一个 id)` → 用同样的 `click` 再 `check_site`，确认 `issues` 为空、点完后的 `text` 确实变了（例如出现了第 1 题）。
4. **没有报错但用户还说不对**：用 `vision_analyze` 看 `snapshots` 里的 `screenshot`（本地图片路径），或者问用户卡在哪一步。
5. **回复**：一句话说查到的原因和改了什么，不贴代码。

## 设计要求
- **手机优先**：用户在手机宽度（约 390px）的 App 内置浏览器里看，也可能切到电脑宽度。必须有 `<meta name="viewport" content="width=device-width, initial-scale=1">`；正文字号 ≥ 15px，可点的地方 ≥ 40px 高；宽屏用 `max-width` 居中，不要横向滚动。
- **结构**：顶部一句话摘要 → 主体（地图 / 卡片 / 表格）→ 注意事项 → 页脚「信息来源」（链接 `target="_blank" rel="noopener"`，注明「价格、营业时间以官方为准，整理于 YYYY-MM-DD」）。
- **风格**：干净、留白、一个主色加一个点缀色；系统字体（`-apple-system, "PingFang SC", sans-serif`）；用 `@media (prefers-color-scheme: dark)` 适配深色模式。
- **交互**：筛选标签、点卡片展开详情、点列表定位到地图上的点，这类轻交互就够了；不要弹窗、自动播放音视频、统计/追踪脚本，不要收集用户信息的表单。

## 旅行/攻略页布局模板（已验证有效）
旅行规划、行程攻略类网页用以下卡片组合，视觉效果好且信息密度高：
- **时间轴行程卡**：左侧竖线 + 圆点编号，每天一张卡片（Day徽章 + 城市 + 景点列表），景点用图标+名称+简介+标签
- **美食网格**：2列（手机）/3列（宽屏）网格，每格一个 emoji + 菜名 + 价格
- **预算对比表**：经济型 vs 舒适型两列，底部加总计行（高亮色）
- **交通卡片**：深色渐变背景 + 白色文字，每行一个交通方式 + 价格徽章
- **贴士卡片**：图标 + 标题 + 描述，竖排排列
- **庆典/活动卡**：左侧日期块（月份+日期）+ 右侧活动名称/地点/描述
- **天气参考卡**：浅蓝背景，城市名 + 温度范围
- **地图**：放在行程之前，让用户先看全貌再看每日详情

## 国际地点坐标获取
- Nominatim 对英文/当地语言地名命中率远高于中文。查韩国、日本、欧洲等地坐标时，优先用英文或当地语言名称（如 "Seoul Station"、"Gyeongbokgung Palace"、"Haeundae Beach"）。
- 一次查不到就换关键词：去掉门牌号、用 "地标名+城市名"、尝试当地语言名称。连续 3 次返回空结果就停止，改用已知地标 + 人工估算。

## 地图（导游图、附近推荐、路线）
- 用 Leaflet：`https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css` 和 `.../leaflet/1.9.4/leaflet.min.js`。
- 底图瓦片（都不要 key；不要用 CARTO，它现在要 key）：
  - 国外地点：`https://tile.openstreetmap.org/{z}/{x}/{y}.png`，attribution `© OpenStreetMap contributors`；或 Esri `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}`，attribution `Tiles © Esri`。
  - 国内地点：高德 `https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`，`subdomains: '1234'`，attribution `© 高德地图`。坐标要用高德坐标（GCJ-02，高德、大众点评、小红书上拿到的一般就是），用 GPS/WGS84 坐标会偏几百米。高德在国外没有底图，国外别用。
- 坐标要真实：从查到的网页、地图链接里拿经纬度；拿不准的点不要硬标，放进列表并标「位置待确认」。
- 已知地址但缺坐标时，用 Nominatim（OpenStreetMap 地理编码）通过 fetch_url 获取：`https://nominatim.openstreetmap.org/search?q=<地址>&format=json&limit=1`，返回的 `lat`/`lon` 就是 WGS84 坐标，可直接用于 Leaflet + OSM 底图。地址用英文或当地语言（如韩文）命中率更高；中文地址经常返回空结果。一次查不到就换关键词（路名+区名、去掉门牌号等）。
- Nominatim 对中文地址命中率很低，连续 2-3 次返回空结果就停止尝试，改用已知地标坐标 + 人工估算偏移量。例如先查到附近几个知名地标（商圈、公园、地铁站）的坐标，再根据餐厅与地标的相对位置估算坐标（误差 200-500 米可接受）。在地图上用估算坐标标注，列表里地址写真实地址即可。
- 一键导航按钮：用 Google Maps 方向链接 `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`，`target="_blank"` 打开，用户点了直接跳导航。
- 地图容器给固定高度（手机上 320–420px）；`fitBounds` 把所有点框进来；标记弹窗里放名称、一句话、价格区间。
- 加一句 `window.addEventListener('resize', () => map.invalidateSize())`：App 里切手机/电脑宽度时地图会变大小，不调用的话新露出来的地方是灰的。
- 标记要醒目：用主色实心圆点 + 白色编号（和列表里的编号对应），带白边和阴影；别用白色空心圆，在浅色底图上看不清。
- 地图加载失败（没网、CDN 打不开）时，下面的列表和卡片照样能看：内容不要只放在地图弹窗里。

## JS 兼容性（重要）
- **用 ES5 写法**：`var` 代替 `const`/`let`，`function` 代替箭头函数，`+` 拼接代替模板字符串。App 内置浏览器/WebView 可能不支持 ES6+ 语法，导致整个脚本报错、页面白屏。
- **字符串引号**：所有 JS 字符串统一用单引号定义。字符串内含中文引号（如 `\u201c`/`\u201d`）用 Unicode 转义，不要用反引号模板字符串——反引号字符串里的 `"` 不是有效转义，会显示为字面 `\"`。
- **循环闭包**：`forEach`/`map` 中需要索引时用 IIFE `(function(i){...})(index)` 捕获，不要用 `let` 循环变量（旧环境不支持块级作用域）。
- **避免现代 API**：不用 `Array.from`、`Object.assign`、`Promise`、`fetch` 等，用 ES5 等价写法。

## 限制
- 外部资源只能用 https（cdnjs、地图瓦片、https 图片）；网页里访问不了 localhost 和内网接口，也不要尝试。
- 不用需要 API key 的服务；图片优先用查到的 https 原图，拿不到就用 emoji 或 CSS 图形代替，不要用占位图网站。
- 整页控制在 300KB 以内；数据多时用 JS 数组渲染，别手写几十段重复 HTML。
