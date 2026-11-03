/**
 * 测试专用管理员密码：仅用于测试/E2E 中临时搭建的实例，不用于任何生产环境。
 *
 * 可通过环境变量 E2E_ADMIN_PASSWORD 覆盖；默认值仅供本地测试自举初始管理员
 * 账号（/api/setup）与登录使用。集中在一处定义，避免散落在各测试文件中。
 */
export const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Admin12345!';
