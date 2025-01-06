document.addEventListener('DOMContentLoaded', function() {
  const features = document.querySelectorAll('.feature');

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('scroll-in');
      } else {
        entry.target.classList.remove('scroll-in');
      }
    });
  }, {
    threshold: 0.1
  });

  features.forEach(feature => {
    observer.observe(feature);
  });
});
