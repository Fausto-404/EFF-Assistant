<h1 align="center">EFF-Assistant AI 安全运营助手</h1>

<div align="center">

<p align="center">
  <a href="https://github.com/Fausto-404/EFF-Assistant/releases">
    <img src="https://img.shields.io/github/v/release/Fausto-404/EFF-Assistant?style=flat-square&label=release&color=blue&cacheSeconds=3600" alt="Release">
  </a>
  <a href="https://github.com/Fausto-404/EFF-Assistant/stargazers">
    <img src="https://img.shields.io/github/stars/Fausto-404/EFF-Assistant?style=flat-square&label=stars&color=brightgreen&cacheSeconds=3600" alt="GitHub Stars">
  </a>
  <a href="https://github.com/Fausto-404/EFF-Assistant/network/members">
    <img src="https://img.shields.io/github/forks/Fausto-404/EFF-Assistant?style=flat-square&label=forks&color=orange&cacheSeconds=3600" alt="GitHub Forks">
  </a>
  <a href="https://github.com/Fausto-404/EFF-Assistant/releases">
    <img src="https://img.shields.io/github/downloads/Fausto-404/EFF-Assistant/total?style=flat-square&label=downloads&color=success&cacheSeconds=3600" alt="Downloads">
  </a>
</p>

</div>

EFF Assistant 是一款面向安全运营人员的 Chrome / Edge 浏览器扩展。

它直接工作在现有 WAF、NDR、IDS/IPS、SOC、SIEM、EDR 等安全设备 Web 控制台之上，无需改造原有平台，即可提供 **快速研判、关联分析、操作历史、生成工单、智能研判** 五项能力。

插件既可以完全独立使用，也可以连接 [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring)，进一步完成资产关联、工单协作和平台级智能研判。

> **核心目标：让现有 WAF、NDR、SOC 等安全设备快速具备告警解析、AI 研判、资产关联与工单联动能力。**


---

## ✨ 两种使用模式 · 四项核心能力

EFF Assistant 提供两种使用模式。

无需部署额外平台，仅配置 Quick AI，即可独立使用 **快速研判、关联分析**；连接 [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring) 后，可进一步使用 **生成工单、智能研判**。

| 使用模式 | 核心能力 | 说明 |
| --- | --- | --- |
| **独立使用** | ⚡ 快速研判 | 读取当前告警页面上下文，调用用户配置的 AI 快速完成单条告警研判 |
| **独立使用** | 🔗 关联分析 | 将多条告警加入同一分析上下文，联合分析攻击行为、时间关系及关联证据 |
| **进阶使用** | ▣ 生成工单 | 连接 EFF-Monitoring，自动解析告警字段、关联资产信息并生成安全工单 |
| **进阶使用** | ◎ 智能研判 | 调用平台 Threat Analysis Agent，结合资产、情报、历史告警等上下文进行深度调查 |

---
## 🖥️ 支持场景

只要安全告警能够在浏览器页面中正常展示，EFF Assistant 即可参与页面上下文采集与 AI 研判。

典型场景包括：

`WAF` · `NDR` · `IDS/IPS` · `SOC` · `SIEM` · `EDR Web 控制台` · `态势感知平台` · `威胁检测平台` · `自研安全运营平台`

---


# 01｜独立使用

只需要配置 Quick AI，无需部署 EFF-Monitoring，即可使用 EFF Assistant 的核心 AI 研判能力。

## ⚡ 快速研判

快速研判面向当前页面中的单条安全告警。

EFF Assistant 自动读取当前页面可见内容，识别告警场景、提取关键证据，并调用用户自行配置的 AI Provider 输出结构化研判结果，**支持多任务并行研判**。

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

适用于：

- WAF 攻击告警
- NDR / IDS / IPS 网络攻击告警
- SOC / SIEM 聚合告警
- EDR Web 控制台事件
- WebShell / 恶意请求 / 漏洞利用告警
- 自研安全运营平台事件
<img width="2968" height="1526" alt="image" src="https://github.com/user-attachments/assets/96e10a96-c10d-4e89-acc4-61de765e2aa1" />



---

## 🔗 关联分析

真实安全事件通常不会只产生一条告警。

单条告警可能只能看到某一个攻击动作，而多个告警组合后，才能进一步识别完整攻击行为。

EFF Assistant 支持将 **多条告警加入同一个分析任务**，由 AI 统一分析这些事件之间的关联关系，**支持跨标签页、跨设备分析**。

典型场景包括：

- 同一源 IP 产生多条攻击告警
- 同一资产连续出现不同类型事件
- 多阶段漏洞利用行为
- 同一攻击者访问多个 URL
- 单条告警证据不足
- 多条相似告警需要联合判断
<img width="2940" height="1510" alt="image" src="https://github.com/user-attachments/assets/b30e9455-b4e0-49dd-93cb-7afed442a604" />

---

# 02｜进阶使用

连接 [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring) 后，EFF Assistant 可以进一步获得资产、告警、威胁情报及运营流程上下文。

## ▣ 生成工单

EFF Assistant 根据当前页面 URL 自动识别安全设备，并调用 EFF-Monitoring 中维护的解析规则，对原始告警进行结构化。

自动提取：

- 安全设备
- 源 IP
- 目的 IP
- 事件类型
- 告警关键字段

随后进一步关联：

- 内部资产
- 资产标签
- IP 黑白名单
- 已知对象属性

最终直接生成 EFF-Monitoring 安全工单。
<img width="2932" height="1518" alt="image" src="https://github.com/user-attachments/assets/6ecb5c8a-1b9a-4495-b5b8-f8dfcb10ad09" />

---

## ◎ 智能研判

连接 EFF-Monitoring 后，可以调用平台侧 Threat Analysis Agent 对安全事件进行进一步调查。

Quick AI 主要分析浏览器当前能够看到的告警内容。

智能研判则可以进一步利用平台内部已经积累的安全上下文：

- 告警结构化字段
- 资产信息
- IP 黑白名单
- 威胁情报
- 历史告警
- 相似事件
- STE 历史研判经验
- Evidence Pack
- 平台分析工具

形成证据增强的安全事件调查。
<img width="2982" height="1532" alt="image" src="https://github.com/user-attachments/assets/adae44be-1049-4245-b225-e4e2001c2118" />

---


## 🤖 Quick AI

独立使用模式下，EFF Assistant 不绑定固定 AI 服务商。

当前支持通过兼容接口配置 AI Provider：

| 协议 | Base URL 示例 |
| --- | --- |
| Anthropic 兼容 | `https://xxx.xxx/anthropic` |
| OpenAI 兼容 | `https://xxx.xxx/v1` |

> **数据安全提示**
>
> 快速研判和关联分析可能读取当前页面中的告警日志、IP、资产信息、HTTP 请求/响应以及攻击 Payload，并发送至用户自行配置的 AI Provider。请根据所在组织的数据安全、保密和合规要求决定是否启用，并优先使用符合组织要求的模型服务。

---

## 🚀 安装

当前推荐通过浏览器开发者模式安装。

### Chrome

1. 下载并解压 EFF Assistant。
2. 打开 `chrome://extensions/`。
3. 开启 **开发者模式**。
4. 点击 **加载已解压的扩展程序**。
5. 选择包含 `manifest.json` 的 `EFF-Assistant` 目录。

安装完成后，通过插件设置页配置 Quick AI；如需使用进阶能力，再配置 EFF-Monitoring。

---

## 🧪 Demo 演示环境

项目提供了一套用于体验 EFF Assistant 的演示环境和设备识别规则，位于：

[Demo](https://github.com/Fausto-404/EFF-Assistant/tree/main/Demo)

其中包括：

- `index.html`：模拟安全设备告警详情页面。
- `安全威胁监测分析平台_设备识别包.json`：EFF-Monitoring 设备规则 / 模板导入包。

### 仅体验独立能力

如果只需要测试：

- 快速研判
- 关联分析

直接打开 Demo 页面并配置 Quick AI 即可，无需部署 EFF-Monitoring。

### 体验进阶能力

如果需要测试：

- 生成工单
- 智能研判

则需要先部署 [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring)。

1. 在 EFF-Monitoring 中进入 **系统配置 → 设备**，新增演示设备。

<img width="2966" height="1520" alt="新增演示设备" src="https://github.com/user-attachments/assets/4947050d-36c8-4a0d-b704-0c8ee882346a" />

2. 导入 Demo 目录中的设备识别包。

<img width="2382" height="1092" alt="导入设备识别包" src="https://github.com/user-attachments/assets/484b0801-cc38-425d-8977-253ee8027677" />

3. 配置对应设备 URL 后，即可通过 EFF Assistant 测试完整流程。

---

## 🤝 反馈与贡献

欢迎通过 Issue / Pull Request：
感谢 @SimoLin 对本项目提出宝贵的建议

如果项目对你的安全运营工作有帮助，欢迎 Star。

---

## 📄 License

本项目基于 [Apache License 2.0](./LICENSE) 开源。
## 📝 更新记录
### v1.1.0

v1.1.0 将 EFF Assistant 从单次页面 AI 研判助手进一步升级为轻量化的浏览器侧安全研判工作台。

- **关联分析**：支持采集多条告警并进行联合研判，输出关联标签、攻击关系、风险与证据链。
- **多任务研判**：研判任务可拖出为独立窗口并行执行，支持拖动、最小化、恢复与任务结果持续回写。
- **操作历史**：统一记录快速研判、智能研判、关联分析与工单操作，支持检索、详情查看及历史结果恢复。
- **交互全面升级**：新增深浅色主题，重构 Popup、设置页及浮动研判窗口，并优化拖拽、状态反馈、AI 配置兼容和页面上下文刷新。
### v1.0.1

**修复：**

- 修复安装时 `chrome.runtime.openOptionsPage()` 报错 `Could not create an options page`（manifest 缺少 `options_page` 声明）
- 修复设置页面 Service Worker 无响应时页面永久挂起的问题
- 修复 `setAccessLevel` 调用了不存在的存储 API（`chrome.storage.local` → `chrome.storage.session`），导致存储安全加固静默失效
- 修复快速研判 AI 推理请求无超时保护，极端情况下可能无限等待
