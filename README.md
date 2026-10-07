# 低温量子器件实验数据校准与噪声谱反演服务

纯后端 Node.js + TypeScript 服务，不依赖数据库、Docker 或第三方运行时。服务从多通道 ADC/IQ 采样、实验时钟、仪器配置和校准版本中重建实验窗口，完成时钟同步、IQ 校准、窗口化、功率谱/互谱计算、相干性分析、噪声类型判别和 T1/T2/Ramsey 等衰减参数拟合。

## 运行

```bash
npm test
npm start
```

默认监听 `127.0.0.1:4387`。

## 主要接口

- `GET /health`
- `POST /v1/analyses`：提交分析任务，返回任务 ID
- `GET /v1/analyses/:id`：读取任务状态或结果
- `POST /v1/analyses/:id/cancel`：取消排队或运行中的任务
- `POST /v1/experiments/preview`：同步、校准并快速预览派生指标
- `POST /v1/experiments/precheck`：提交前预检，复用分析请求的样本与校准配置，不执行频谱或衰减拟合，按通道和时间范围报告校准缺失、角色不匹配、有效期重叠、温度修正无效和 invalid sample，并给出 `ready`（可直接提交）/ `fixable`（修复后提交）/ `abort`（放弃）结论；预检不修改输入

服务只使用内存任务存储；任务结果通过版本化的输入快照和校准版本引用保证可追溯。
