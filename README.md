# EFF Assistant

> 面向安全运营场景的浏览器 AI 助手，让现有 WAF、NDR、SOC 等安全设备快速具备告警解析、AI 研判与工单联动能力。

EFF Assistant 是一款面向安全运营人员的浏览器扩展插件。

它可以直接读取当前安全设备 Web 控制台中的告警上下文，在不改造原有安全设备的情况下，快速完成告警字段识别、AI 快速研判，并可连接 [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring) 完成工单生成和平台级智能研判。

---
## 🖥️ 支持场景

理论上只要告警内容能够在浏览器页面中正常显示，EFF Assistant 即可进行采集并完成AI研判、协作流转。

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

## ✨ 核心能力

EFF Assistant 当前提供三项主要能力：

### ⚡ 快速研判

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
<img width="2966" height="1524" alt="image" src="https://github.com/user-attachments/assets/179baa61-67db-487a-88a5-95bd220faf15" />


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

然后选择 EFF Assistant 项目目录即可。
