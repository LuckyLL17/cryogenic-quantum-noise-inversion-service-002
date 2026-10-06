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

服务只使用内存任务存储；任务结果通过版本化的输入快照和校准版本引用保证可追溯。
