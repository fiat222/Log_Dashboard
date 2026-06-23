import http from 'k6/http';
import { check, sleep } from 'k6';

 export const options = {
// //   vus: 50,              // จำนวน Virtual Users
// //   duration: '30s',      // ระยะเวลาในการทดสอบ
        discardResponseBodies: true,
 };
//
export default function () {
   const res = http.get('https://gened.psu.ac.th',{
            timeout: '30s'
           });

     check(res, {
         'status is 200': (r) => r.status === 200,
//             'body is not empty': (r) => r.body.length > 0,
     });
     //sleep(1); // พักก่อนรอบถัดไป (จำลองผู้ใช้จริง)
//     console.log(res.body)
}
