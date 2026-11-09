import { LookupEnv, handleRequest } from './handler';

export default {
  fetch(request: Request, env: LookupEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
