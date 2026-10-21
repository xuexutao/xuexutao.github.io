$(document).ready(function() {
    var $postMd = $(".post-md");
    if ($postMd.length === 0) return;

    var selectors = [];
    for (var level = 1; level <= 6; level++) {
        if ($postMd.find("h" + level).length > 0) {
            selectors.push("h" + level);
        }
    }

    if (selectors.length === 0) {
        $(".left-toc-container").hide();
        return;
    }

    $("#toc").tocify({
        context: ".post-md",
        selectors: selectors.join(","),
        showAndHide: true,
        smoothScroll: true,
        scrollTo: 24,
        extendPage: false
    });
});
