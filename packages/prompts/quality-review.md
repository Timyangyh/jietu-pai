# Quality Review

对输出图进行评分，输出 JSON。

字段：
- `styleScore`: 1-5，光线、构图、色彩、场景是否接近参考图。
- `identityScore`: 1-5，是否保留人物图主要脸部特征。
- `qualityScore`: 1-5，是否清晰、自然、无明显畸形。
- `usabilityScore`: 1-5，用户是否愿意保存。
- `risk`: `pass` / `fail` / `unknown`。
- `failureReasons`: 字符串数组。

可以先人工评分；如需严谨对比，可自行增加客观指标和更多样本。
