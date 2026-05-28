# 协作弹窗高度问题修复总结

## 问题描述

协作弹窗（CreateCollaborationModal）在参与者较多时，弹窗高度超出视口，导致顶部和底部内容不可见。

## 根本原因

1. **参与者列表区域过高**：maxHeight: 150px，当参与者多时会撑大弹窗
2. **Modal 组件无最大高度限制**：内容可以无限增高
3. **无内部滚动机制**：所有内容都在同一容器中，无法独立滚动

## 修复方案

### 1. 减小参与者列表高度 ✅

**改进前：**
```css
maxHeight: 150px
```

**改进后：**
```css
maxHeight: 120px  /* 减小30px */
```

同时优化了：
- 使用 CSS 变量统一边框颜色
- 减小 padding（4px→6px）
- 添加背景色
- 增大列表项的 padding 提升可读性
- 添加悬停背景色过渡效果
- 优化空状态文案样式
- 添加 checkbox 主题色

### 2. 为 Modal 添加最大高度限制 ✅

```css
.content {
  max-height: calc(100vh - 80px);  /* 视口高度减去80px边距 */
  display: flex;
  flex-direction: column;
}
```

### 3. 添加内容滚动区域 ✅

**新增的 CSS：**
```css
.scrollContent {
  overflow-y: auto;  /* 垂直滚动 */
  flex: 1;           /* 占据剩余空间 */
  min-height: 0;     /* 允许缩小到比内容更小 */
}
```

**新增的组件属性：**
```typescript
interface ModalProps {
  // ...现有属性
  scrollable?: boolean  // 是否启用内容滚动，默认 true
}
```

**Modal 组件结构更新：**
```tsx
<Modal open={open} title="创建协作任务" scrollable={true}>
  {/* 内容自动包裹在 scrollContent div 中 */}
</Modal>
```

### 4. 其他布局优化 ✅

- 为 overlay 添加 padding（`var(--spacing-lg)`）
- 为 titleRow 添加 `flex-shrink: 0` 防止被压缩
- 为 Modal 添加 `display: flex; flex-direction: column` 确保正确的弹性布局

## 视觉变化

### 修复前：
- 弹窗高度无限制
- 参与者列表区域高 150px
- 无内部滚动
- 底部按钮可能超出视口

### 修复后：
- 弹窗最大高度限制为 `calc(100vh - 80px)`
- 参与者列表区域高 120px（减小 30px）
- 内容区域可独立滚动
- 标题和按钮区域固定，始终可见
- 整个弹窗在 60px 视口边距内（顶部/底部各 40px）

## 兼容性

- ✅ CSS `calc()` 函数：现代浏览器广泛支持
- ✅ `flex` 布局：现代浏览器广泛支持
- ✅ `overflow-y: auto`：标准滚动行为
- ✅ 降级方案：即使不支持 calc，也不会破坏布局

## 文件修改

- `packages/dashboard/src/features/groups/CreateCollaborationModal.tsx`
  - 减小参与者列表高度
  - 优化列表项样式
  - 启用 scrollable 模式

- `packages/dashboard/src/components/ui/Modal/Modal.tsx`
  - 添加 scrollable 属性
  - 添加 scrollContent div 包装

- `packages/dashboard/src/components/ui/Modal/Modal.module.css`
  - 添加最大高度限制
  - 添加滚动区域样式
  - 优化弹性布局

- `packages/dashboard/src/features/groups/CreateIssueModal.tsx`
  - 同步启用 scrollable 模式以保持一致性

## 测试要点

1. **高度测试**：参与者很多时，弹窗不应超出视口
2. **滚动测试**：内容区域应可独立滚动，标题和按钮始终可见
3. **响应式测试**：在不同视口高度下都应正常工作
4. **已有功能**：确认检查框选择、表单提交等功能正常
5. **Issue 弹窗**：确认 Issue 弹窗也获得相同的滚动优化
