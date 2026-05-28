/**
 * 单聊发送定制卡片消息（参考 openclaw dingtalk-connector 的 AI Card 流程）
 *
 * 使用分步方式：创建卡片实例 → 投放卡片
 * 接口文档：https://open.dingtalk.com/document/isvapp/create-and-deliver-cards
 */

const APP_KEY = "dingqemzltrlwf6xkmsk";
const APP_SECRET = "JlEbPWPht4sfiq49YU6alVQGTcabNHRy-L9tr3ZkCJWo1deyqo-0dbT2RmgLlDnC";
const ROBOT_CODE = APP_KEY;
const USER_ID = "300343";

const CARD_TEMPLATE_ID = "2ee04b1e-3ea7-445c-bc9d-66adf2445547.schema";

async function getToken() {
  const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: APP_KEY, appSecret: APP_SECRET }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`获取 token 失败: ${JSON.stringify(data)}`);
  return data.accessToken;
}

async function main() {
  try {
    const token = await getToken();
    const cardInstanceId = `card_${Date.now()}`;

    // step 1: 创建卡片实例（使用定制模板）
    console.log(">> 创建卡片实例...");
    const createRes = await fetch("https://api.dingtalk.com/v1.0/card/instances", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        cardTemplateId: CARD_TEMPLATE_ID,
        outTrackId: cardInstanceId,
        cardData: {
          cardParamMap: {
            avatar: "https://work.alibaba-inc.com/photo/443379.48x48.jpg",
            nick: "西花",
            location: "养老阵地样式修改-主任务",
            message: "你好，西花！有什么我可以帮你的？",
            link: "https://aima.antgroup-inc.cn/workspace/dashboard/detail?requirementId=3600020",
          },
        },
        callbackType: "STREAM",
        imRobotOpenSpaceModel: { supportForward: true },
      }),
    });
    const createData = await createRes.json();
    console.log(">> 创建结果:", JSON.stringify(createData));

    // step 2: 投放卡片给用户
    console.log(">> 投放卡片...");
    const deliverRes = await fetch("https://api.dingtalk.com/v1.0/card/instances/deliver", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        outTrackId: cardInstanceId,
        userIdType: 1,
        openSpaceId: `dtv1.card//IM_ROBOT.${USER_ID}`,
        imRobotOpenDeliverModel: {
          spaceType: "IM_ROBOT",
          robotCode: ROBOT_CODE,
          extension: { dynamicSummary: "true" },
        },
      }),
    });
    const deliverData = await deliverRes.json();
    console.log(">> 投放结果:", JSON.stringify(deliverData));

    console.log(">> 发送完成");
  } catch (err) {
    console.error(">> 出错:", err.message);
  }
}

main();
