import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const sdk=await readFile(new URL('../../node_modules/@supabase/supabase-js/dist/umd/supabase.js',import.meta.url),'utf8');
test.beforeEach(async({page})=>{
  await page.route('https://cdn.jsdelivr.net/**',route=>route.fulfill({contentType:'text/javascript',body:sdk}));
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
});
test('unconfigured production never silently enables demo login',async({page})=>{
  await page.goto('/');
  await expect(page.locator('#connbar')).toContainText('Setup required');
  await page.getByRole('button',{name:'Staff Login',exact:true}).click();
  await expect(page.locator('#main')).toContainText('Connect a backend');
  await expect(page.locator('#main')).not.toContainText('admin123');
});
test('demo booking progresses through warehouse, dispatch and delivery',async({page})=>{
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.TRACKER_CONFIG={demo:true}'}));
  await page.goto('/');
  await page.getByRole('button',{name:'Staff Login',exact:true}).click();
  await page.locator('[name=staffId]').fill('SK-0001');
  await page.locator('[name=password]').fill('admin123');
  await page.locator('#loginForm button[type=submit]').click();
  await page.locator('[name=s_name]').fill('Sender Test');
  await page.locator('[name=s_phone]').fill('08012345678');
  await page.locator('[name=s_city]').fill('Lagos');
  await page.locator('[name=r_name]').fill('Receiver Test');
  await page.locator('[name=r_phone]').fill('08023456789');
  await page.locator('[name=r_city]').fill('Abuja');
  await page.locator('[name=r_address]').fill('10 Test Road');
  await page.locator('[name=desc]').fill('Books');
  await page.locator('[name=weight]').selectOption('1kg – 3kg');
  await page.getByRole('button',{name:'Save Parcel',exact:true}).click();
  await expect(page.locator('#bookingConfirmPanel')).toContainText('Parcel booked');
  await page.locator('[data-receive-instore]').click();
  await page.getByRole('button',{name:'Dispatch',exact:true}).click();
  await expect(page.locator('#main')).toContainText('Receiver Test');
  // Create the first real rider rather than depending on seeded production data.
  await page.getByRole('button',{name:'Dispatch',exact:true}).click();
  await page.locator('#riderForm [name=name]').fill('Test Rider');
  await page.locator('#riderForm [name=phone]').fill('08034567890');
  await page.locator('#riderForm button[type=submit]').click();
  await page.getByRole('button',{name:'Dispatch',exact:true}).click();
  await page.locator('[data-rider-select]').selectOption({label:'Test Rider — Dispatch Bike'});
  await page.locator('[data-dispatch]').click();
  await page.locator('[data-deliver]').click();
  await page.getByRole('button',{name:'Admin',exact:true}).click();
  await expect(page.locator('tr[data-detail]')).toContainText('Delivered');
  expect(errors).toEqual([]);
});
test('configured app starts signed out, loads staff data after login, and clears it on logout',async({page})=>{
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  const operations=[];
  await page.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.TRACKER_CONFIG={supabaseUrl:"https://test.supabase.co",supabaseAnonKey:"fixture-key",demo:false}'}));
  const user={id:'10000000-0000-0000-0000-000000000001',email:'sk-0001@staff.stallionking.internal',aud:'authenticated'};
  const admin={id:'a1',data:{name:'Live Administrator',staffId:'SK-0001',role:'superadmin',active:true}};
  const jwt=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})).toString('base64url')+'.fixture';
  await page.route('https://test.supabase.co/**',async route=>{
    const url=new URL(route.request().url()); operations.push(url.pathname);
    let data={};
    if(url.pathname==='/auth/v1/token') data={access_token:jwt,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user};
    if(url.pathname==='/auth/v1/user') data=user;
    if(url.pathname.startsWith('/rest/v1/')){
      const table=url.pathname.split('/').at(-1);
      const object=route.request().headers().accept?.includes('vnd.pgrst.object');
      const rows=table==='profiles' ? [{admin_doc_id:'a1'}] : table==='admins' ? [admin] : table==='clients' ? [{id:'c1',data:{name:'Private Business Client',phone:'08012345678',city:'Lagos'}}] : [];
      data=object ? rows[0] || null : rows;
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Staff Login',exact:true}).click();
  expect(operations.filter(x=>x.startsWith('/rest/'))).toEqual([]);
  await page.locator('[name=staffId]').fill('SK-0001');
  await page.locator('[name=password]').fill('A-strong-test-password');
  await page.locator('#loginForm button[type=submit]').click();
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  await expect(page.locator('#main')).toContainText('Private Business Client');
  await page.getByRole('button',{name:'Profile menu'}).click();
  await page.locator('[data-logout]').first().click();
  await expect(page.locator('#main')).not.toContainText('Private Business Client');
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  await expect(page.locator('#loginForm')).toBeVisible();
  expect(errors).toEqual([]);
});
