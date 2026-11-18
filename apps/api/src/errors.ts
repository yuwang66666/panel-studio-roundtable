export class AppError extends Error { constructor(public code:string,message:string,public status=400){super(message);} }
export const conflict=(message='讨论状态已变化，请刷新后重试')=>new AppError('CONFLICT',message,409);
export function safeError(error:unknown):AppError { return error instanceof AppError?error:new AppError('INTERNAL','操作失败，请检查服务日志或重试',500); }
