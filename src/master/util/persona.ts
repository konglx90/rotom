/**
 * 群里所有定时任务的人设名。
 *
 * 不是 LLM —— 只是一个跑腿的 scheduler:到点检查某 agent 有没有回复,
 * 有就汇报、没就升级。所有用户可见处(系统消息、Dashboard 列表、#reply 胶囊)
 * 统一挂这个名字,避免出现 ask-bridge:<uuid> 这种机器脸。
 *
 * 名字取自鲁滨逊的仆人"星期五":忠实跑腿、传话、汇报。
 */
export const TIMER_PERSONA_NAME = "星期五";
