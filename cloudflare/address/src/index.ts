import { handleRequest } from './handler';

export default {
  fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  },
};
