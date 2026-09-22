const studentView = document.getElementById('studentView');
const adminView = document.getElementById('adminView');
const toast = document.getElementById('toast');
const toastTitle = document.getElementById('toastTitle');
const toastText = document.getElementById('toastText');
let toastTimeout;

function showToast(title, text) {
  toastTitle.textContent = title;
  toastText.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3600);
}

document.querySelectorAll('.role').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.role').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    const admin = button.dataset.role === 'admin';
    studentView.classList.toggle('hidden', admin);
    adminView.classList.toggle('hidden', !admin);
    document.getElementById('studentNav').style.opacity = admin ? '.48' : '1';
    showToast(admin ? 'Teacher workspace preview' : 'Student portal preview', admin ? 'You are viewing the educator dashboard.' : 'You are viewing Aarav’s learning dashboard.');
  });
});

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => {
    const messages = {
      watch: ['Opening lesson player', 'The recorded lesson experience will be connected in the next build.'],
      create: ['Create lesson', 'Lesson creation flow is ready to be connected to the content system.'],
      review: ['Opening learner submission', 'The marking and feedback workspace will appear here.']
    };
    showToast(...messages[button.dataset.action]);
  });
});

document.querySelectorAll('.nav-item[data-page], .text-button').forEach(button => {
  button.addEventListener('click', () => {
    const page = button.dataset.page;
    if (page === 'home') return;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const target = document.querySelector(`.nav-item[data-page="${page}"]`);
    if(target) target.classList.add('active');
    showToast(`${page[0].toUpperCase() + page.slice(1)} module`, 'This area is included in the product plan and ready for its detailed screen.');
  });
});

document.getElementById('closeToast').addEventListener('click', () => toast.classList.remove('show'));
