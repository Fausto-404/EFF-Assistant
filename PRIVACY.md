# EFF Assistant Privacy Policy / 隐私政策

**Effective Date / 生效日期：2026-08-12**  
**Policy Version / 政策版本：1.0**

EFF Assistant is a browser extension designed for security operations and alert investigation. This Privacy Policy explains what data EFF Assistant may access, store, and transmit when you use the extension, and how you can control that data.

EFF Assistant 是一款面向安全运营与告警研判场景的浏览器扩展。本隐私政策说明 EFF Assistant 在使用过程中可能访问、保存和传输哪些数据，以及用户可以如何控制这些数据。

---

## 1. Scope / 适用范围

This Privacy Policy applies to the EFF Assistant browser extension and its built-in features, including:

- Quick AI analysis;
- Smart / platform-enhanced analysis through a user-configured EFF-Monitoring instance;
- Multi-alert correlation analysis;
- Ticket creation and related EFF-Monitoring operations;
- Local operation history and correlation clue storage;
- User-configured AI provider connections.

本隐私政策适用于 EFF Assistant 浏览器扩展及其内置功能，包括：

- 快速 AI 研判；
- 通过用户自行配置的 EFF-Monitoring 实例进行智能 / 平台增强研判；
- 多告警关联分析；
- 工单生成及相关 EFF-Monitoring 操作；
- 本地操作历史和关联线索存储；
- 用户自行配置的 AI Provider 接入。

EFF Assistant does not require a developer-operated cloud account to provide its core browser-side functions. Remote requests are made only to services configured or explicitly used by the user, such as an AI provider or EFF-Monitoring deployment.

EFF Assistant 的浏览器侧核心功能不要求用户登录由扩展开发者运营的云端账户。远程请求仅会发送至用户自行配置或明确使用的服务，例如 AI Provider 或 EFF-Monitoring 部署。

---

## 2. Data EFF Assistant May Access / EFF Assistant 可能访问的数据

### 2.1 Website Content and Page Context / 网页内容与页面上下文

When EFF Assistant is enabled on an HTTP/HTTPS page, and especially when the user explicitly starts an analysis or correlation operation, the extension may access:

- Visible text from the current page;
- The current page URL;
- The current page title;
- Security alert text, event details, or other visible security context contained on the page.

当 EFF Assistant 在 HTTP/HTTPS 页面启用，尤其是用户主动发起研判、关联分析等操作时，扩展可能访问：

- 当前页面的可见文本；
- 当前页面 URL；
- 当前页面标题；
- 页面中可见的安全告警文本、事件详情及其他安全上下文。

EFF Assistant is designed for security operations pages such as WAF, NDR, SOC, SIEM, EDR, and similar security consoles. However, because the extension can be enabled on general HTTP/HTTPS pages, users should only invoke analysis on pages whose content they are authorized to process.

EFF Assistant 主要面向 WAF、NDR、SOC、SIEM、EDR 等安全运营页面。但由于扩展可在普通 HTTP/HTTPS 页面启用，用户应仅在其有权处理相关内容的页面上发起研判。

### 2.2 Authentication and Connection Configuration / 鉴权及连接配置

Depending on the features configured by the user, EFF Assistant may store and use:

- AI API endpoint / Base URL;
- AI API Key or other authentication credentials;
- AI model identifier;
- Custom request headers configured by the user;
- EFF-Monitoring Base URL;
- EFF-Monitoring access token;
- Platform/device/workspace information returned by the configured EFF-Monitoring instance.

根据用户启用和配置的功能，EFF Assistant 可能保存和使用：

- AI API 地址 / Base URL；
- AI API Key 或其他鉴权凭据；
- AI 模型标识；
- 用户配置的自定义请求头；
- EFF-Monitoring Base URL；
- EFF-Monitoring Access Token；
- 配置的 EFF-Monitoring 实例返回的平台、设备、工作区等信息。

These credentials are used only to communicate with the services selected by the user.

这些鉴权信息仅用于访问用户自行选择和配置的服务。

### 2.3 Operation History / 操作历史

EFF Assistant may store a local operation history containing information such as:

- Operation type (for example Quick Analysis, Smart Analysis, Correlation Analysis, or Ticket Creation);
- Result summary;
- Timestamp;
- Related page URL and title;
- Result payload needed to view or restore a historical analysis.

EFF Assistant 可能在本地保存操作历史，包括：

- 操作类型（例如快速研判、智能研判、关联分析、生成工单）；
- 结果摘要；
- 时间戳；
- 相关页面 URL 和标题；
- 查看或恢复历史研判结果所需的结果数据。

The current implementation retains up to **30** operation history entries locally.

当前实现最多在本地保留 **30 条**操作历史记录。

### 2.4 Correlation Clues / 关联分析线索

When the user explicitly selects **Collect Current Alert / 采集当前告警**, EFF Assistant may locally store:

- Page title;
- Page URL;
- A short summary;
- Collected visible alert text;
- Collection timestamp.

当用户主动选择 **“采集当前告警”** 时，EFF Assistant 可能在本地保存：

- 页面标题；
- 页面 URL；
- 告警摘要；
- 采集的页面可见告警文本；
- 采集时间。

The current implementation retains up to **12** correlation clues locally. Each collected clue may contain up to approximately **24,000 characters** of page text.

当前实现最多在本地保留 **12 条**关联分析线索。单条线索最多可能包含约 **24,000 个字符**的页面文本。

### 2.5 UI and Functional Preferences / UI 与功能偏好

EFF Assistant may store settings such as:

- Whether the assistant is enabled;
- Theme preference;
- Floating assistant position;
- AI protocol and endpoint mode;
- Whether current-page text is allowed to be sent for Quick AI analysis.

EFF Assistant 可能保存以下设置：

- 页面助手是否启用；
- 深色 / 浅色主题；
- 浮动助手位置；
- AI 协议及端点模式；
- 是否允许快速 AI 读取并发送当前页面可见文本。

---

## 3. How Data Is Used / 数据用途

EFF Assistant uses accessed or stored data only to provide its security-analysis functions.

EFF Assistant 仅将访问或保存的数据用于提供安全研判相关功能。

### 3.1 Quick AI Analysis / 快速 AI 研判

When the user enables Quick AI and explicitly starts Quick Analysis, EFF Assistant may send the relevant visible page text and page context to the **AI service configured by the user**.

当用户启用快速 AI 并主动发起快速研判时，EFF Assistant 可能将相关页面可见文本和页面上下文发送至**用户自行配置的 AI 服务**。

The extension does not require the use of a specific commercial AI provider. The destination is determined by the API endpoint configured by the user.

扩展不强制使用特定商业 AI Provider，数据发送目标由用户填写的 API Endpoint 决定。

### 3.2 Correlation Analysis / 关联分析

When the user starts correlation analysis, the selected correlation clues may be sent to the user-configured AI service so that the alerts can be jointly analyzed.

当用户发起关联分析时，被选中的关联线索可能发送至用户配置的 AI 服务，用于多条告警的联合研判。

### 3.3 EFF-Monitoring Platform Functions / EFF-Monitoring 平台能力

When the user configures and connects an EFF-Monitoring instance, EFF Assistant may send security context to that configured platform for functions such as:

- Page parsing;
- Smart / platform-enhanced investigation;
- Ticket creation;
- Message template retrieval;
- Ticket-related webhook operations.

当用户配置并连接 EFF-Monitoring 实例后，EFF Assistant 可能向该平台发送安全上下文，以实现：

- 页面解析；
- 智能 / 平台增强研判；
- 工单生成；
- 消息模板获取；
- 工单相关 Webhook 操作。

Depending on the operation, transmitted data may include page text, URL, title, device identifier, parse token, template identifier, or related alert identifiers.

根据具体操作，传输的数据可能包括页面文本、URL、标题、设备标识、解析 Token、模板标识或相关告警标识。

### 3.4 Connection Testing and Model Discovery / 连接测试与模型发现

When the user requests **Test AI / 测试 AI** or **Get Models / 获取模型**, the extension may send minimal requests to the configured AI endpoint to verify connectivity or retrieve available model information.

当用户主动执行 **“测试 AI”** 或 **“获取模型”** 时，扩展可能向用户配置的 AI Endpoint 发送最小化请求，用于验证连通性或获取可用模型信息。

---

## 4. Local Storage / 本地存储

EFF Assistant uses browser extension storage, including `chrome.storage.local` and limited session storage, to support configuration and workflow state.

EFF Assistant 使用浏览器扩展存储（包括 `chrome.storage.local` 及有限的会话存储）保存配置和工作流状态。

Locally stored information may include:

- AI and EFF-Monitoring configuration;
- API keys, access tokens, and custom headers;
- Operation history;
- Correlation clues;
- UI preferences;
- Short-lived analysis routing/cache data.

本地保存的信息可能包括：

- AI 与 EFF-Monitoring 配置；
- API Key、Access Token 和自定义请求头；
- 操作历史；
- 关联分析线索；
- UI 偏好；
- 短期研判路由 / 缓存数据。

**Important:** EFF Assistant currently does not add application-level encryption to API keys, tokens, or other configuration values stored in browser extension local storage. Users should protect their browser profile and operating-system account accordingly.

**重要说明：** EFF Assistant 当前不会对保存在浏览器扩展本地存储中的 API Key、Token 等配置额外实施应用层加密。用户应妥善保护浏览器用户配置文件及操作系统账户。

Some temporary scene-classification cache data may be stored in browser session storage and is designed to expire after a short period. The current scene-cache TTL is approximately **10 minutes**.

部分页面场景分类缓存可能保存在浏览器会话存储中，并设计为短期失效。当前场景缓存有效期约为 **10 分钟**。

---

## 5. Data Sharing and Third-Party Services / 数据共享与第三方服务

EFF Assistant does **not** sell user data.

EFF Assistant **不会出售用户数据**。

EFF Assistant does not include advertising SDKs or analytics/tracking services intended to build advertising profiles.

EFF Assistant 不包含用于构建广告画像的广告 SDK 或分析 / 跟踪服务。

Data may be transmitted to the following services only when the corresponding feature is configured or invoked by the user:

1. **User-configured AI provider** — for Quick AI analysis, correlation analysis, model discovery, or connectivity testing.
2. **User-configured EFF-Monitoring instance** — for page parsing, smart investigation, ticket creation, and related platform operations.

只有在用户配置或主动调用相应功能时，数据才可能发送至：

1. **用户自行配置的 AI Provider** —— 用于快速研判、关联分析、模型发现或连接测试；
2. **用户自行配置的 EFF-Monitoring 实例** —— 用于页面解析、智能研判、工单生成及相关平台操作。

EFF Assistant does not control the privacy practices, retention policies, security controls, or training policies of third-party AI providers or independently deployed EFF-Monitoring services. Users should review the privacy and data-processing terms of the services they configure.

EFF Assistant 无法控制第三方 AI Provider 或独立部署的 EFF-Monitoring 服务的数据处理、保存期限、安全控制或模型训练政策。用户应自行确认所配置服务的隐私政策及数据处理条款。

---

## 6. Network Security / 网络安全

EFF Assistant supports user-configured HTTP and HTTPS endpoints.

EFF Assistant 支持用户自行配置 HTTP 或 HTTPS Endpoint。

Users are strongly encouraged to use **HTTPS** for AI services and EFF-Monitoring connections. If a user intentionally configures an unencrypted HTTP endpoint, transmitted data may not be protected by TLS while in transit.

强烈建议用户为 AI 服务和 EFF-Monitoring 使用 **HTTPS**。如果用户主动配置未加密的 HTTP Endpoint，相关数据在网络传输过程中可能不受 TLS 加密保护。

---

## 7. Browser Permissions / 浏览器权限说明

EFF Assistant may request the following browser permissions:

### `storage`

Used to store extension configuration, credentials, UI preferences, local operation history, correlation clues, and related workflow state.

用于保存扩展配置、鉴权信息、UI 偏好、本地操作历史、关联分析线索及相关工作流状态。

### `scripting`

Used to inject the packaged EFF Assistant interface and content script into supported HTTP/HTTPS pages. It is not used to download or execute remotely hosted JavaScript.

用于向支持的 HTTP/HTTPS 页面注入扩展包内置的 EFF Assistant 界面及 Content Script，不用于下载或执行远程托管的 JavaScript。

### `tabs`

Used to identify supported tabs, obtain the active page URL/title where required, synchronize the assistant state, and support page-level security workflows.

用于识别支持的标签页、在必要时读取活动页面 URL / 标题、同步页面助手状态以及支持页面级安全研判工作流。

### `activeTab`

Used to access the active page when the user interacts with EFF Assistant and initiates page-related actions.

用于在用户主动操作 EFF Assistant 并发起页面相关功能时访问当前活动标签页。

### Optional HTTP/HTTPS host permissions

EFF Assistant may request access to HTTP/HTTPS origins because users can configure their own AI endpoints and EFF-Monitoring addresses. Network access is used only for the configured service or supported page workflow.

由于用户可以自行配置 AI Endpoint 和 EFF-Monitoring 地址，EFF Assistant 可能请求 HTTP/HTTPS Origin 访问权限。相关网络访问仅用于用户配置的服务或扩展的页面安全研判流程。

---

## 8. Remote Code / 远程代码

EFF Assistant does **not** download, evaluate, or execute remote JavaScript or WebAssembly as part of its normal operation.

EFF Assistant 在正常运行过程中**不会**下载、动态求值或执行远程 JavaScript / WebAssembly。

All JavaScript executed by the extension is packaged with the extension. Responses received from configured AI or EFF-Monitoring APIs are treated as data, not executable code.

扩展执行的 JavaScript 均随扩展包一起发布。从用户配置的 AI 或 EFF-Monitoring API 获取的响应仅作为数据处理，不作为可执行代码运行。

---

## 9. Data Retention and Deletion / 数据保留与删除

EFF Assistant is designed to keep workflow data locally unless a user invokes a function that requires transmission to a configured remote service.

EFF Assistant 默认在本地保存工作流数据；只有用户主动使用需要远程处理的功能时，相关数据才会发送至用户配置的服务。

Current local retention behavior includes:

- Operation history: up to **30 entries**;
- Correlation clues: up to **12 entries**;
- Temporary scene cache: approximately **10 minutes**;
- Configuration and credentials: retained until changed, cleared through browser/extension controls, or the extension data is removed.

当前本地保留策略包括：

- 操作历史：最多 **30 条**；
- 关联分析线索：最多 **12 条**；
- 临时场景缓存：约 **10 分钟**；
- 配置及鉴权信息：持续保留，直至用户修改、通过浏览器 / 扩展控制清除，或扩展数据被移除。

Users can:

- Clear operation history from the EFF Assistant settings page;
- Remove individual correlation clues or clear all collected clues;
- Disconnect EFF-Monitoring;
- Change or remove AI / authentication configuration;
- Remove the extension or clear its extension data through browser controls.

用户可以：

- 在 EFF Assistant 设置页清空操作历史；
- 删除单条关联线索或清空全部关联线索；
- 断开 EFF-Monitoring；
- 修改或移除 AI / 鉴权配置；
- 通过浏览器控制删除扩展或清除扩展数据。

Data already transmitted to an AI provider or EFF-Monitoring instance is subject to the retention and deletion controls of that external service.

已经发送至 AI Provider 或 EFF-Monitoring 实例的数据，其后续保留和删除规则由对应外部服务决定。

---

## 10. User Choice and Control / 用户选择与控制

EFF Assistant is designed around explicit user configuration and action.

EFF Assistant 的数据处理以用户主动配置和主动操作为主要原则。

Users can choose:

- Whether to enable the page assistant;
- Whether to configure Quick AI;
- Which AI endpoint and model to use;
- Whether current-page visible text may be sent for Quick AI analysis;
- Whether to connect EFF-Monitoring;
- When to collect an alert as a correlation clue;
- When to run Quick Analysis, Smart Analysis, Correlation Analysis, or ticket operations.

用户可以决定：

- 是否启用页面助手；
- 是否配置快速 AI；
- 使用哪个 AI Endpoint 和模型；
- 是否允许快速 AI 发送当前页面可见文本；
- 是否连接 EFF-Monitoring；
- 何时采集告警作为关联线索；
- 何时发起快速研判、智能研判、关联分析或工单操作。

---

## 11. Sensitive and Regulated Data / 敏感及受监管数据

EFF Assistant is intended for authorized security operations use. Security pages may contain IP addresses, hostnames, usernames, URLs, event logs, application data, or other sensitive organizational information.

EFF Assistant 仅应被用于经过授权的安全运营场景。安全页面可能包含 IP 地址、主机名、用户名、URL、事件日志、应用数据或其他组织敏感信息。

Users are responsible for ensuring that they have authorization to process such information and that their configured AI provider and EFF-Monitoring environment satisfy applicable organizational, contractual, legal, and regulatory requirements.

用户有责任确保其有权处理相关信息，并确认所配置的 AI Provider 与 EFF-Monitoring 环境符合所在组织、合同、法律及监管要求。

Users should avoid sending secrets, personal information, or regulated information to third-party AI services unless such processing has been explicitly approved.

未经明确批准，不建议用户将秘密信息、个人信息或受监管数据发送至第三方 AI 服务。

---

## 12. Children's Privacy / 儿童隐私

EFF Assistant is a professional security-operations tool and is not directed to children.

EFF Assistant 是面向专业安全运营人员的工具，并非面向儿童设计。

The extension does not intentionally collect information from children for advertising, profiling, or consumer services.

扩展不会出于广告、画像或消费者服务目的主动收集儿童信息。

---

## 13. Changes to This Privacy Policy / 隐私政策更新

This Privacy Policy may be updated when EFF Assistant's functionality, data flows, permissions, or third-party integrations materially change.

当 EFF Assistant 的功能、数据流、浏览器权限或第三方集成发生实质变化时，本隐私政策可能进行更新。

The latest version will be published with the EFF Assistant project. The effective date at the top of this document indicates the latest revision date.

最新版本将随 EFF Assistant 项目公开发布。本文顶部的生效日期代表最近一次修订日期。

---

## 14. Contact / 联系方式

For privacy questions, security concerns, or requests related to EFF Assistant, please contact the project maintainer through:

**GitHub Issues:**  
https://github.com/Fausto-404/EFF-Assistant/issues

如对 EFF Assistant 的隐私、数据处理或安全问题存在疑问，请通过以下方式联系项目维护者：

**GitHub Issues：**  
https://github.com/Fausto-404/EFF-Assistant/issues

---

## 15. Summary / 摘要

In summary:

- EFF Assistant reads page content for security analysis only when the relevant assistant workflow is enabled or invoked;
- Page content may be sent to the AI endpoint or EFF-Monitoring instance configured by the user;
- Configuration, credentials, history, and correlation clues may be stored locally in browser extension storage;
- EFF Assistant does not sell user data;
- EFF Assistant does not include advertising or behavioral tracking SDKs;
- EFF Assistant does not execute remotely hosted code;
- Users remain in control of which remote services are configured and when analysis actions are performed.

简而言之：

- EFF Assistant 仅在相关助手功能启用或用户主动操作时读取页面内容用于安全研判；
- 页面内容可能发送至用户自行配置的 AI Endpoint 或 EFF-Monitoring 实例；
- 配置、鉴权凭据、操作历史及关联线索可能保存在浏览器扩展本地存储中；
- EFF Assistant 不出售用户数据；
- EFF Assistant 不包含广告或行为跟踪 SDK；
- EFF Assistant 不执行远程托管代码；
- 用户可以自行决定配置哪些远程服务以及何时发起研判操作。
