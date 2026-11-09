import { SubsEnv, handleRequest } from './handler';

export default {
  fetch(request: Request, env: SubsEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
