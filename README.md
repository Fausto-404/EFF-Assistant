# EFF Assistant

> 面向安全运营场景的浏览器 AI 助手，让现有 WAF、NDR、SOC 等安全设备快速具备告警解析、AI 研判与工单联动能力。

EFF Assistant 是一款面向安全运营人员的浏览器扩展插件。

它可以直接读取当前安全设备 Web 控制台中的告警上下文，在不改造原有安全设备的情况下，快速完成告警字段识别、AI 快速研判，并可连接 [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring) 完成工单生成和平台级智能研判。

---

## ✨ 核心能力

EFF Assistant 当前提供三项主要能力：

### ⚡ 快速研判

无需连接 EFF-Monitoring，可独立使用。

插件读取当前页面可见告警文本，并调用用户自行配置的 AI 服务完成快速研判。

```text
当前安全设备页面
        ↓
页面上下文采集
        ↓
告警场景识别
        ↓
关键证据提取
        ↓
Quick AI
        ↓
结构化安全研判
```

研判结论统一为：

- `业务行为`
- `存在攻击意图`
- `攻击失败`
- `攻击成功`
- `非告警事件`
- `无法确认`

支持合理的多标签组合，例如：

```text
[存在攻击意图] [攻击失败]

[存在攻击意图] [攻击成功]

[存在攻击意图] [无法确认]
```

并在插件侧进行结论互斥校验，避免出现：

```text
攻击成功 + 攻击失败
业务行为 + 存在攻击意图
非告警事件 + 攻击成功
```

等不合理结果。

---

### ◎ 智能研判

连接 EFF-Monitoring 后，可直接调用平台侧 Threat Analysis Agent。

相比浏览器侧快速研判，平台智能研判可以进一步结合：

- 告警结构化字段
- 资产信息
- IP 黑白名单
- 威胁情报
- 历史告警
- 相似事件
- STE 历史研判经验
- Evidence Pack
- 平台分析工具

完成更完整的安全事件调查与证据化研判。

```text
当前告警
   ↓
EFF Parser
   ↓
资产 / IP名单 / TI / 历史事件 / STE
   ↓
Evidence Pack
   ↓
Threat Analysis Agent
   ↓
智能研判结果
```

---

### ▣ 一键生成工单

EFF Assistant 可以根据当前页面 URL 自动识别对应安全设备，并调用 EFF-Monitoring 中维护的解析规则。

```text
安全设备告警页面
        ↓
URL 自动识别设备
        ↓
获取页面可见文本
        ↓
EFF Parser
        ↓
设备 / 源IP / 目的IP / 事件
        ↓
生成工单
```

无需在安全设备与 EFF-Monitoring 之间开发专用 API 对接。

---

## 🧩 浏览器助手

EFF Assistant 采用轻量悬浮助手交互。

鼠标移动到助手后，会展开三个操作：

```text
        EFF Assistant
             │
    ┌────────┼────────┐
    │        │        │
生成工单   智能研判   快速研判
```

鼠标移动到对应功能后才展开相应详情，不持续占用页面空间。

支持：

- 拖动助手位置
- 自动保存显示状态
- 新标签页自动加载
- 页面间保持助手配置
- Hover 分级交互
- 研判结果跟随助手显示

---

## 🤖 Quick AI

快速研判 AI 支持两类协议：

### Anthropic 兼容

Base URL 示例：

```text
https://xxx.xxx/anthropic
```

### OpenAI 兼容

Base URL 示例：

```text
https://xxx.xxx/v1
```

## 🔗 EFF-Monitoring 联动

EFF Assistant 可以独立使用。

连接 EFF-Monitoring 后，可以解锁更多安全运营能力：

```text
EFF Assistant
      │
      │ Plugin API
      ▼
EFF-Monitoring
      │
      ├── 设备识别
      ├── 正则解析
      ├── 工单生成
      ├── 资产关联
      ├── IP名单
      ├── Threat Agent
      ├── STE经验
      └── 工单流转
```

EFF-Monitoring：

https://github.com/Fausto-404/EFF-Monitoring

---

## 🖥️ 支持场景

理论上只要告警内容能够在浏览器页面中正常显示，EFF Assistant 即可进行采集。

典型场景包括：

- WAF
- NDR
- IDS / IPS
- SOC
- SIEM
- 态势感知平台
- EDR Web 控制台
- 威胁检测平台
- 自研安全运营平台

不同安全设备可以在 EFF-Monitoring 中分别维护：

```text
设备名称
设备 URL
解析规则
消息模板
```

EFF Assistant 根据当前页面 URL 自动选择对应设备规则。

---

## 🚀 安装

当前推荐通过开发者模式安装。

### Chrome

打开：

```text
chrome://extensions/
```

开启：

```text
开发者模式
```

选择：

```text
加载已解压的扩展程序
```

然后选择 EFF Assistant 项目目录。

- Star
- Issue
- Pull Request
- 提交新的设备识别规则
- 分享实际安全运营场景中的改进建议
