export type ServiceResponse<T = unknown> = {
  statusCode: number;
  body: T;
};
