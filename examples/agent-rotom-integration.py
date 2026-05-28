#!/usr/bin/env python3
"""
Rotom 消息投递状态集成示例
展示如何在 Agent 中优雅地处理 rotom group send 的投递状态
"""

import json
import subprocess
from typing import Dict, Any

class RotomMessenger:
    """封装 rotom CLI 调用，自动解释投递状态"""

    def __init__(self, group_id: str):
        self.group_id = group_id

    def send_message(self, target: str, message: str) -> Dict[str, Any]:
        """
        发送消息并返回带有人类可读解释的响应

        Args:
            target: 目标接收者（Agent 名称）
            message: 消息内容

        Returns:
            dict: {
                'raw_response': {...},  # 原始 JSON 响应
                'interpretation': {
                    'status': 'delivered|queued|failed',
                    'message': '人类可读的解释',
                    'agent_should_continue': bool  # 是否可以继续后续逻辑
                }
            }
        """
        # 调用 rotom CLI
        try:
            result = subprocess.run([
                'rotom', 'group', 'send',
                self.group_id, target, message
            ], capture_output=True, text=True)

            if result.returncode != 0:
                return {
                    'raw_response': None,
                    'interpretation': {
                        'status': 'failed',
                        'message': f'命令执行失败: {result.stderr}',
                        'agent_should_continue': False
                    }
                }

            # 解析 JSON 响应
            raw_response = json.loads(result.stdout.strip())

            # 生成解释
            interpretation = self._interpret_response(raw_response, target, message)

            return {
                'raw_response': raw_response,
                'interpretation': interpretation
            }

        except json.JSONDecodeError as e:
            return {
                'raw_response': None,
                'interpretation': {
                    'status': 'failed',
                    'message': f'无法解析 JSON 响应: {e}',
                    'agent_should_continue': False
                }
            }
        except Exception as e:
            return {
                'raw_response': None,
                'interpretation': {
                    'status': 'failed',
                    'message': f'未知错误: {e}',
                    'agent_should_continue': False
                }
            }

    def _interpret_response(self, raw_response: Dict[str, Any], target: str, message: str) -> Dict[str, Any]:
        """解释 rotom 响应并返回人类可读的解释"""
        delivered = raw_response.get('delivered', False)
        queued = raw_response.get('queued', False)
        error = raw_response.get('error')

        if delivered:
            return {
                'status': 'delivered',
                'message': f'✅ @{target} 已在线，消息实时送达。',
                'agent_should_continue': True
            }
        elif queued:
            return {
                'status': 'queued',
                'message': f'⏳ @{target} 离线中，消息已离线缓存。对方上线后会看到。我可以先进行其他工作，或等待对方回复。',
                'agent_should_continue': True
            }
        else:
            if error:
                message = f'❌ 消息投递失败：{error}'
            else:
                message = '❓ 未知投递状态（请联系管理员）'

            return {
                'status': 'failed',
                'message': message,
                'agent_should_continue': False  # 失败时不应继续后续逻辑
            }


# 使用示例
if __name__ == '__main__':
    # 初始化 Messenger（传入群 ID）
    messenger = RotomMessenger('cda34ffc-c8e9-428b-b9da-2bec7c6039d1')

    # 示例 1：发送给在线 Agent（实时送达）
    print("=== 示例 1：发送给在线 Agent ===")
    result = messenger.send_message('小寿', '@小寿 帮我看看这个问题')
    print(f"原始响应: {json.dumps(result['raw_response'], indent=2)}")
    print(f"解释: {result['interpretation']['message']}")
    print()

    # 示例 2：发送给离线 Agent（离线缓存）
    print("=== 示例 2：发送给离线 Agent ===")
    result = messenger.send_message('西花-前端', '@西花-前端 这个问题需要你确认')
    print(f"原始响应: {json.dumps(result['raw_response'], indent=2)}")
    print(f"解释: {result['interpretation']['message']}")
    print()

    # 示例 3：投递失败
    print("=== 示例 3：投递失败 ===")
    result = messenger.send_message('不存在的Agent', '测试' * 1000)  # 消息过长可能失败
    print(f"原始响应: {json.dumps(result['raw_response'], indent=2)}")
    print(f"解释: {result['interpretation']['message']}")
