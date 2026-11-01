import axios, { AxiosRequestConfig } from "axios";

const httpRequest = <T>(req: AxiosRequestConfig): Promise<T> => {
  return new Promise(async (resolve, reject) => {
    try {
      const request = await axios(req);
      resolve(request.data.data);
    } catch (e) {
      reject(e);
    }
  });
};

export default httpRequest;
