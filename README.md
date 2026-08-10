<h1 align="center">EFF Assistant AI安全运营助手</h1>

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
EFF Assistant 是一款面向安全运营人员的 Chrome / Edge 浏览器扩展，它可以直接读取当前安全设备 Web 控制台中的告警上下文，在不改造原有安全设备的情况下，快速完成告警字段识别、AI 快速研判，并可连接EFF-Monitoring完成工单生成和平台级智能研判。

---

**安全运营协作平台请查看：** [EFF-Monitoring](https://github.com/Fausto-404/EFF-Monitoring)

## 🖥️ 支持场景

理论上只要告警内容能够在浏览器页面中正常显示，EFF Assistant 即可进行采集并参与 AI 研判与协作流转。

典型场景包括：

`WAF` · `NDR` · `IDS/IPS` · `SOC` · `SIEM` · `EDR Web 控制台` · `态势感知平台` · `威胁检测平台` · `自研安全运营平台`

---

## ✨ 核心能力

| 能力 | 说明 |
| --- | --- |
| ⚡ **快速研判** | 直接读取当前页面告警上下文，调用用户自行配置的 AI，输出结构化研判结论与关键证据 |
| ▣ **生成工单** | 根据当前页面 URL 自动识别安全设备，解析设备、源 IP、目的 IP、事件等字段并生成 EFF-Monitoring 工单 |
| ◎ **智能研判** | 连接 EFF-Monitoring 后调用 Threat Analysis Agent，结合资产、威胁情报、历史告警、相似事件与 STE 经验进行证据增强研判 |

### 快速研判

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
<img width="3010" height="1540" alt="image" src="https://github.com/user-attachments/assets/fd80774f-bef1-412e-9aa6-9fce4ba305f3" />



### 智能研判

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
<img width="2998" height="1526" alt="image" src="https://github.com/user-attachments/assets/5b2ece46-c178-43f4-a90a-9b6fe3935bd4" />

---

### 一键生成工单

EFF Assistant 可以根据当前页面 URL 自动识别对应安全设备，并调用 EFF-Monitoring 中维护的解析规则快速生成工单，格式化为消息模版进行通报。

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
<img width="2980" height="1532" alt="image" src="https://github.com/user-attachments/assets/4adfdc0b-c88c-4a4c-bb3d-e4c3809d18ad" />

---

## 🤖 Quick AI

快速研判支持用户自行配置 AI Provider，不绑定固定服务商。

| 协议 | Base URL 示例 |
| --- | --- |
| Anthropic 兼容 | `https://xxx.xxx/anthropic` |
| OpenAI 兼容 | `https://xxx.xxx/v1` |

> 快速研判可能读取当前页面中的告警日志、IP、资产信息、HTTP 请求/响应及攻击 Payload，并发送至用户自行配置的 AI Provider。请根据所在组织的数据安全与合规要求决定是否启用。

---

## 🚀 安装

当前推荐通过开发者模式安装。

### Chrome / Edge

1. 下载并解压 EFF Assistant。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`。
3. 开启 **开发者模式**。
4. 点击 **加载已解压的扩展程序**。
5. 选择 EFF Assistant 目录。

> 安装完成后，可通过插件设置页配置 EFF-Monitoring 或 Quick AI。

---

## 📄 License

本项目基于 [Apache License 2.0](./LICENSE) 开源。

---

## 🤝 反馈与贡献

欢迎通过 Issue / Pull Request：

- 提交新的安全设备适配规则
- 反馈实际安全运营场景中的兼容性问题
- 提出 Quick AI 与 EFF-Monitoring 联动能力的改进建议

如果项目对你的工作有帮助，欢迎 Star。
